"""文件落盘与流式播放。

- 下载：依次尝试 base_url 与 backup_url（B 站流 CDN 有多个镜像，部分 mcdn 地址
  可能不在白名单内或不可达），临时文件 + 原子改名落盘。
- 路径安全：bvid 等外部输入构造的路径，一律先做文件名白名单校验，再校验
  resolve 后必须位于 music_dir / cover_dir 内，杜绝路径穿越；写文件用
  mkstemp 文件描述符打开，不经过派生路径。
- 播放：实现 HTTP Range（RFC 7233），前端进度条拖动、锁屏快进都依赖它。
"""

import asyncio
import os
import re
import tempfile
from pathlib import Path

import httpx
from fastapi.responses import FileResponse, StreamingResponse
from starlette.responses import Response

from app.core.url_guard import UnsafeUrlError, validate_bilibili_url

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")
_CHUNK = 1 << 16
# 文件名白名单：仅字母数字与 . _ -（BV 号天然满足），拒绝任何路径成分
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# 分段并发下载：B 站 CDN 对单连接限速，多连接 Range 分段可数倍提速
_MIN_SEGMENT = 256 * 1024          # 低于 512KB 的文件不分段
_PREFER_SEGMENT_SIZE = 1024 * 1024  # 目标每段 ~1MB
_MAX_SEGMENTS = 8                  # 单文件最大分段数
_SEG_RETRIES = 3                   # 单段重试次数
_BILI_REFERER = {"Referer": "https://www.bilibili.com/"}


class DownloadError(Exception):
    pass


class PathSafetyError(Exception):
    pass


class FileStore:
    def __init__(self, music_dir: Path, cover_dir: Path) -> None:
        self.music_dir = music_dir.resolve()
        self.cover_dir = cover_dir.resolve()
        self.music_dir.mkdir(parents=True, exist_ok=True)
        self.cover_dir.mkdir(parents=True, exist_ok=True)
        # 全局并发连接池：所有任务的所有分段共享，防止批量导入时连接数爆炸
        self._seg_sem = asyncio.Semaphore(_MAX_SEGMENTS)

    # ---- 路径安全 ----

    def _safe_path_in(self, base: Path, name: str) -> Path:
        """在 base 目录内构造文件路径：文件名过白名单，且解析后必须直接位于 base 下。"""
        if not _SAFE_NAME_RE.match(name) or ".." in name:
            raise PathSafetyError(f"非法文件名：{name!r}")
        base_resolved = base.resolve()
        path = (base_resolved / name).resolve()
        if path.parent != base_resolved:
            raise PathSafetyError(f"路径越出允许目录：{name!r}")
        return path

    def _validated_media_path(self, path: Path) -> Path:
        """校验给定路径必须直接位于允许目录（music_dir / cover_dir）之下。"""
        resolved = path.resolve()
        for root in (self.music_dir, self.cover_dir):
            if resolved.parent == root:
                return resolved
        raise PathSafetyError(f"路径越出允许目录：{path}")

    def audio_path(self, bvid: str) -> Path:
        return self._safe_path_in(self.music_dir, f"{bvid}.m4a")

    def cover_path(self, bvid: str) -> Path:
        return self._safe_path_in(self.cover_dir, f"{bvid}.jpg")

    # ---- 下载 ----

    async def download(
        self,
        http: httpx.AsyncClient,
        urls: list[str],
        dest: Path,
        *,
        on_progress=None,
    ) -> None:
        """下载第一个可用的地址到 dest；全部失败抛 DownloadError。

        on_progress(done_bytes, total_bytes) 会在下载过程中被回调。
        """
        dest = self._validated_media_path(dest)
        last_error: Exception | None = None
        for url in urls:
            try:
                validate_bilibili_url(url)
            except UnsafeUrlError as exc:
                last_error = exc
                continue
            try:
                await self._download_smart(http, url, dest, on_progress)
                return
            except (httpx.HTTPError, OSError) as exc:
                last_error = exc
                continue
        raise DownloadError(f"下载失败：{last_error or '无可用地址'}")

    async def _download_smart(
        self,
        http: httpx.AsyncClient,
        url: str,
        dest: Path,
        on_progress,
    ) -> None:
        """优先分段并发下载；Range 不可用或分段失败时回退单流。"""
        total = 0
        try:
            async with http.stream(
                "GET", url, headers={**_BILI_REFERER, "Range": "bytes=0-0"}
            ) as resp:
                if resp.status_code == 206:
                    m = re.search(r"/(\d+)\s*$", resp.headers.get("content-range", ""))
                    if m:
                        total = int(m.group(1))
                elif resp.status_code == 200:
                    total = int(resp.headers.get("content-length") or 0)
        except httpx.HTTPError:
            total = 0

        if total >= 2 * _MIN_SEGMENT:
            try:
                await self._download_segmented(http, url, dest, total, on_progress)
                return
            except (httpx.HTTPError, OSError):
                pass  # 分段失败（如 CDN 限流），落回单流
        await self._download_one(http, url, dest, on_progress)

    async def _download_segmented(
        self,
        http: httpx.AsyncClient,
        url: str,
        dest: Path,
        total: int,
        on_progress,
    ) -> None:
        n = min(_MAX_SEGMENTS, max(2, total // _PREFER_SEGMENT_SIZE))
        bounds = [
            (i * total // n, (i + 1) * total // n - 1) for i in range(n)
        ]
        fd, tmp_name = tempfile.mkstemp(
            dir=str(dest.parent), prefix=dest.name + ".", suffix=".part"
        )
        done = 0
        try:
            os.ftruncate(fd, total)  # 预分配，各分段按偏移写入

            async def seg(start: int, end: int) -> None:
                nonlocal done
                async with self._seg_sem:
                    for attempt in range(1, _SEG_RETRIES + 1):
                        written = 0
                        try:
                            async with http.stream(
                                "GET",
                                url,
                                headers={**_BILI_REFERER, "Range": f"bytes={start}-{end}"},
                            ) as resp:
                                if resp.status_code != 206:
                                    raise httpx.HTTPStatusError(
                                        f"HTTP {resp.status_code}",
                                        request=resp.request,
                                        response=resp,
                                    )
                                offset = start
                                async for chunk in resp.aiter_bytes(_CHUNK):
                                    os.pwrite(fd, chunk, offset)
                                    offset += len(chunk)
                                    written = offset - start
                                    done += len(chunk)
                                    if on_progress:
                                        on_progress(done, total)
                            if offset != end + 1:
                                raise httpx.HTTPError("分段数据不完整")
                            return
                        except (httpx.HTTPError, OSError):
                            done -= written  # 回退该段已计进度后重试
                            if attempt >= _SEG_RETRIES:
                                raise
                            await asyncio.sleep(0.5 * attempt)

            await asyncio.gather(*(seg(s, e) for s, e in bounds))
            os.close(fd)
            fd = -1
            os.replace(tmp_name, dest)
        except BaseException:
            if fd >= 0:
                os.close(fd)
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    async def _download_one(
        self,
        http: httpx.AsyncClient,
        url: str,
        dest: Path,
        on_progress,
    ) -> None:
        # 临时文件经 mkstemp 建在目标目录内，落定后原子改名，失败即清理
        fd, tmp_name = tempfile.mkstemp(
            dir=str(dest.parent), prefix=dest.name + ".", suffix=".part"
        )
        done = 0
        try:
            with os.fdopen(fd, "wb") as f:
                async with http.stream(
                    "GET", url, headers=_BILI_REFERER
                ) as resp:
                    if resp.status_code != 200:
                        raise httpx.HTTPStatusError(
                            f"HTTP {resp.status_code}", request=resp.request, response=resp
                        )
                    total = int(resp.headers.get("content-length") or 0)
                    async for chunk in resp.aiter_bytes(_CHUNK):
                        f.write(chunk)
                        done += len(chunk)
                        if on_progress:
                            on_progress(done, total)
            os.replace(tmp_name, dest)
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

    # ---- 删除 ----

    def delete_song_files(self, audio_path: str, cover_path: str) -> None:
        for raw in (audio_path, cover_path):
            try:
                path = self._validated_media_path(Path(raw))
            except (PathSafetyError, OSError, ValueError):
                continue
            try:
                os.remove(path)
            except OSError:
                pass

    # ---- 流式响应 ----

    def audio_response(self, path: Path, range_header: str | None) -> Response:
        try:
            path = self._validated_media_path(path)
        except (PathSafetyError, OSError, ValueError):
            return Response(status_code=404)
        if not path.exists():
            return Response(status_code=404)
        size = path.stat().st_size

        if not range_header:
            return FileResponse(
                path,
                media_type="audio/mp4",
                headers={"Accept-Ranges": "bytes", "Content-Length": str(size)},
            )

        m = _RANGE_RE.match(range_header.strip())
        if not m:
            return FileResponse(path, media_type="audio/mp4")

        raw_start, raw_end = m.groups()
        if raw_start == "" and raw_end == "":
            return FileResponse(path, media_type="audio/mp4")

        if raw_start == "":  # bytes=-N：末尾 N 字节
            length = min(int(raw_end), size)
            start, end = size - length, size - 1
        else:
            start = int(raw_start)
            end = min(int(raw_end), size - 1) if raw_end else size - 1

        if start >= size or start > end:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}"},
            )

        content_length = end - start + 1

        def iter_range():
            with open(path, "rb") as f:
                f.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = f.read(min(_CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        return StreamingResponse(
            iter_range(),
            status_code=206,
            media_type="audio/mp4",
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(content_length),
            },
        )

    def cover_response(self, path: Path) -> Response:
        try:
            path = self._validated_media_path(path)
        except (PathSafetyError, OSError, ValueError):
            return Response(status_code=404)
        if not path.exists():
            return Response(status_code=404)
        return FileResponse(path, media_type="image/jpeg")
