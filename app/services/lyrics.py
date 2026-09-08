"""歌词服务：B 站字幕 + LRCLIB 混合取词。

来源优先级（质量从高到低）：
1. B 站人工 CC 字幕（UP 主上传的歌词字幕，带时间轴）；
2. LRCLIB 正式歌词（开源歌词库，syncedLyrics 即标准 LRC，免 key）；
3. 网易云歌词（非官方接口，中文覆盖最好；限频 + 失败冷却 + 静默降级，仅收带轴）；
4. B 站 AI 字幕（语音识别兜底，唱歌部分准确率一般）；
5. LRCLIB 纯文本歌词（无轴，前端静态展示）。

LRCLIB 明确标为 instrumental 的曲目保留纯音乐提示，不用 AI 字幕覆盖。

LRCLIB 请求走独立的 httpx 客户端（不带 B 站 cookie，登录态不外泄）。
取词结果统一为文本存库：带时间轴的 LRC，或无轴纯文本（前端降级静态展示）。
"""

import asyncio
import logging
import re
import time
from types import SimpleNamespace

import httpx

from app.bili.client import BiliApiError, BiliClient, VideoRef
from app.bili.subtitle import subtitle_body_to_lrc
from app.db.models import Song
from app.services import library

log = logging.getLogger(__name__)

_LRCLIB = "https://lrclib.net/api"
_LRCLIB_TIMEOUT = 10.0
_DURATION_TOLERANCE = 3.0  # LRCLIB 结果时长与歌曲时长的匹配容差（秒）
_INSTRUMENTAL_TEXT = "纯音乐，请欣赏"

# 网易云（非官方接口）：进程级限频与失败冷却，第三方故障不拖慢取词主链路
_NETEASE_API = "https://music.163.com"
_NETEASE_MIN_INTERVAL = 1.5
_NETEASE_COOLDOWN = 60.0
_ncm_state = {"last": 0.0, "cooldown_until": 0.0}
_SYNCED_HEAD_RE = re.compile(r"\[\d{1,2}:\d{2}")

# B 站标题里的标签/噪声（【4K】【官方MV】、Official Video、翻唱、无损音源…）
_BRACKET_RE = re.compile(r"【[^】]*】|\[[^\]]*\]|「[^」]*」|『[^』]*』|（[^）]*）|\([^)]*\)")
_BRACKET_INNER_RE = re.compile(r"【([^】]*)】|\[([^\]]*)\]|「([^」]*)」|『([^』]*)』|（([^）]*)）|\(([^)]*)\)")
_SEPARATOR_RE = re.compile(r"[|｜/·◆★\-—–\s]+")
_NOISE_RE = re.compile(
    r"(official|music\s*video|mv|pv|live|现场|cover|翻唱|remix|feat|ft\b|"
    r"lyrics?|歌词|伴奏|纯音乐|instrumental|音源|无损|flac|hi-?res|hd|"
    r"[48]k|1080|720|高清|超清|蓝光|画质|修复|\bai\b|aigc|完整版|完整|cut|纯享|饭拍|直拍|自制|动态)",
    re.IGNORECASE,
)


def title_candidates(title: str) -> list[str]:
    """B 站视频标题 → LRCLIB 搜索用的歌名候选列表。

    书名号先转分隔（「周杰伦《晴天》」→ 两段），再去括号标签、按分隔符切段
    并丢弃纯噪声段，得到「清洗全串」；多段时各段单独成候选（B 站标题常见
    「歌名-歌手」混写）；最后兜底原始标题。
    """
    title = title.replace("《", " ").replace("》", " ")
    stripped = _BRACKET_RE.sub(" ", title).strip()
    from_brackets = False
    if not stripped:  # 整个标题都在括号里（如【晴天】）：改用括号内容
        stripped = " ".join(
            next(g for g in m.groups() if g is not None)
            for m in _BRACKET_INNER_RE.finditer(title)
        ).strip()
        from_brackets = True
    segments = [s.strip() for s in _SEPARATOR_RE.split(stripped) if s.strip()]
    segments = [s for s in segments if _keep_segment(s)]
    cands: list[str] = []
    if segments:
        cands.append(" ".join(segments))
        if len(segments) > 1:
            cands.extend(s for s in segments if len(s) >= 2)
    raw = title.strip()
    if raw and not from_brackets and raw not in cands:  # 括号兜底时原始标题无增量
        cands.append(raw)
    out: list[str] = []
    for c in cands:
        if c and c not in out:
            out.append(c)
    return out[:4]


def _keep_segment(seg: str) -> bool:
    """保留有信息量的段：过长的和去掉噪声词后不剩什么的（4K/MV/官方…）丢弃。"""
    if len(seg) > 24:
        return False
    return bool(_NOISE_RE.sub("", seg).strip())


def pick_lrclib_result(items: list[dict], duration: int) -> tuple[str, bool] | None:
    """从 LRCLIB 搜索结果里选最匹配的一条，返回 (歌词, 是否带时间轴)。

    时长容差内（±3s）才参与匹配，带轴（syncedLyrics）优先、时长最接近优先；
    instrumental=True 视为官方确认的纯音乐，直接返回标注文本。
    """
    best: tuple[tuple[int, float], dict] | None = None
    for item in items or []:
        if not isinstance(item, dict):
            continue
        item_duration = float(item.get("duration") or 0)
        if duration and item_duration and abs(item_duration - duration) > _DURATION_TOLERANCE:
            continue
        if item.get("instrumental"):
            return (_INSTRUMENTAL_TEXT, False)
        synced = str(item.get("syncedLyrics") or "").strip()
        plain = str(item.get("plainLyrics") or "").strip()
        if not synced and not plain:
            continue
        rank = (1 if synced else 0, -abs(item_duration - duration) if duration else 0.0)
        if best is None or rank > best[0]:
            best = (rank, item)
    if best is None:
        return None
    item = best[1]
    synced = str(item.get("syncedLyrics") or "").strip()
    if synced:
        return (synced, True)
    return (str(item.get("plainLyrics") or "").strip(), False)


class LyricsService:
    def __init__(self, bili: BiliClient, http: httpx.AsyncClient | None = None) -> None:
        self.bili = bili
        # 不复用 BiliClient 的 http：B 站 cookie 不能发给第三方歌词库
        self.http = http or httpx.AsyncClient(
            timeout=_LRCLIB_TIMEOUT,
            headers={"User-Agent": "BiliMusic/1.0 (self-hosted music library)"},
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    # ---- 取词 ----

    async def ensure_for_song(self, song_id: int, *, force: bool = False) -> None:
        """确保歌曲尝试过取词并落库（含失败标记 checked，避免反复打外部接口）。"""
        song = library.get_song(song_id)
        if song is None or (song.lyrics_checked and not force):
            return
        result = None
        try:
            result = await self.fetch_for_song(song)
        except BiliApiError as exc:
            log.warning("取词失败（B 站接口）%s: %s", song.bvid, exc.message)
        except Exception as exc:  # noqa: BLE001  外部服务异常统一兜底
            log.warning("取词失败 %s: %s", song.bvid, exc)
        lyrics, source = result if result else ("", "")
        library.update_lyrics(song_id, lyrics, source)

    async def fetch_for_song(self, song: Song) -> tuple[str, str] | None:
        """按优先级取词，返回 (文本, 来源 cc/lrclib/ai)；全部落空返回 None。"""
        body = await self._subtitle_body(song, ai_only=False)
        if body:
            return subtitle_body_to_lrc(body), "cc"
        from_lrclib = await self._from_lrclib(song.title, song.artist, song.duration)
        if from_lrclib:
            text, synced = from_lrclib
            if synced or text == _INSTRUMENTAL_TEXT:
                return text, "lrclib"
        from_ncm = await self._from_netease(song.title, song.artist, song.duration)
        if from_ncm:
            return from_ncm
        body = await self._subtitle_body(song, ai_only=True)
        if body:
            return subtitle_body_to_lrc(body), "ai"
        if from_lrclib:
            return from_lrclib[0], "lrclib"
        return None

    # ---- 试听预览取词（不落库；曲库外 bvid 也能看歌词） ----

    _PREVIEW_TTL = 600
    _preview_cache: dict[str, tuple[float, tuple[str, str] | None]] = {}

    async def fetch_preview(self, bvid: str, title: str, artist: str, duration: int) -> tuple[str, str] | None:
        """实时流试听歌取词：现解析 cid/aid 后走与曲库相同的取词链路，结果进程内缓存。"""
        hit = self._preview_cache.get(bvid)
        if hit and time.time() < hit[0]:
            return hit[1]
        result: tuple[str, str] | None = None
        try:
            info = await self.bili.get_video_info(VideoRef(bvid=bvid))
            fake = SimpleNamespace(
                bvid=bvid, cid=info.cid, aid=info.avid,
                title=title, artist=artist, duration=duration,
            )
            result = await self.fetch_for_song(fake)  # type: ignore[arg-type]
        except Exception as exc:  # noqa: BLE001  试听歌取词失败不影响播放
            log.warning("试听取词失败 %s: %s", bvid, exc)
        self._preview_cache[bvid] = (time.time() + self._PREVIEW_TTL, result)
        return result

    # ---- B 站字幕 ----

    async def _subtitle_body(self, song: Song, *, ai_only: bool) -> list[dict] | None:
        """取指定类型的字幕行；接口出错视为没有（外层还有别的来源可试）。"""
        if not song.bvid or not song.cid:
            return None
        try:
            tracks = await self.bili.get_subtitle_tracks(song.bvid, song.aid, song.cid)
        except BiliApiError as exc:
            log.warning("字幕接口失败 %s: %s", song.bvid, exc.message)
            return None
        pool = [
            t for t in tracks
            if bool(t.get("ai_type")) == ai_only and t.get("subtitle_url")
        ]
        if not pool:
            return None
        # 中文轨优先（zh-CN / zh-Hans / ai-zh …）
        pool.sort(key=lambda t: 0 if str(t.get("lan") or "").lower().startswith("zh") else 1)
        try:
            body = await self.bili.download_subtitle_body(pool[0]["subtitle_url"])
        except (BiliApiError, httpx.HTTPError):
            return None
        return body or None

    # ---- LRCLIB ----

    async def _from_lrclib(self, title: str, artist: str, duration: int) -> tuple[str, bool] | None:
        """按歌名候选逐个搜索：先「歌名+UP主」，再纯关键词；命中即返回。"""
        for candidate in title_candidates(title):
            queries: list[dict] = []
            if artist.strip():
                queries.append({"track_name": candidate, "artist_name": artist.strip()})
            queries.append({"q": candidate})
            for params in queries:
                items = await self._lrclib_search(params)
                hit = pick_lrclib_result(items, duration)
                if hit:
                    return hit
        return None

    async def _lrclib_search(self, params: dict) -> list[dict]:
        try:
            resp = await self.http.get(_LRCLIB + "/search", params=params)
        except httpx.HTTPError:
            return []
        if resp.status_code != 200:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        return data if isinstance(data, list) else []

    # ---- 网易云（非官方接口） ----

    async def _netease_throttle(self) -> None:
        now = time.monotonic()
        if now < _ncm_state["cooldown_until"]:
            return  # 冷却中：跳过本次请求（外层拿到空结果自然降级）
        gap = time.monotonic() - _ncm_state["last"]
        if gap < _NETEASE_MIN_INTERVAL:
            await asyncio.sleep(_NETEASE_MIN_INTERVAL - gap)
        _ncm_state["last"] = time.monotonic()

    async def _netease_search(self, query: str) -> list[dict]:
        if time.monotonic() < _ncm_state["cooldown_until"]:
            return []  # 冷却中：不碰网易云（调用方自然降级到后续来源）
        await self._netease_throttle()
        try:
            resp = await self.http.get(
                _NETEASE_API + "/api/search/get/web",
                params={"s": query, "type": 1, "limit": 5},
                headers={"Referer": _NETEASE_API},
            )
        except httpx.HTTPError:
            _ncm_state["cooldown_until"] = time.monotonic() + _NETEASE_COOLDOWN
            return []
        if resp.status_code != 200:
            return []
        try:
            data = resp.json()
        except ValueError:
            return []
        if not isinstance(data, dict):
            return []
        songs = (data.get("result") or {}).get("songs") or []
        return [song for song in songs if isinstance(song, dict) and song.get("id")]

    async def _netease_lyric(self, song_id: int) -> str:
        if time.monotonic() < _ncm_state["cooldown_until"]:
            return ""
        await self._netease_throttle()
        try:
            resp = await self.http.get(
                _NETEASE_API + "/api/song/lyric",
                params={"id": song_id, "lv": 1, "kv": 1},
                headers={"Referer": _NETEASE_API},
            )
        except httpx.HTTPError:
            _ncm_state["cooldown_until"] = time.monotonic() + _NETEASE_COOLDOWN
            return ""
        if resp.status_code != 200:
            return ""
        try:
            return str((resp.json().get("lrc") or {}).get("lyric") or "")
        except ValueError:
            return ""

    async def _from_netease(self, title: str, artist: str, duration: int) -> tuple[str, str] | None:
        """网易云搜索：歌名候选（+UP主）逐个试，时长容差内且带时间轴才采纳（来源 ncm）。"""
        for candidate in title_candidates(title)[:2]:
            queries: list[str] = []
            if artist.strip():
                queries.append(f"{candidate} {artist.strip()}")
            queries.append(candidate)
            for query in queries:
                for item in await self._netease_search(query):
                    duration_ms = int(item.get("duration") or 0)
                    if duration and duration_ms and abs(duration_ms / 1000 - duration) > _DURATION_TOLERANCE:
                        continue
                    lyric = await self._netease_lyric(int(item["id"]))
                    if lyric and _SYNCED_HEAD_RE.search(lyric[:200]):
                        return lyric.strip(), "ncm"
        return None
