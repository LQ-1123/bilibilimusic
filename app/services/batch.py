"""批量导入：识别收藏夹/系列链接并展开为逐视频导入任务。

- 支持输入：收藏夹明链（space.bilibili.com/{mid}/favlist?fid=xxx）、
  系列明链（space.bilibili.com/{mid}/channel/collectiondetail?sid=xxx）、
  带 fid/sid 的任意文本、b23.tv 短链（自动跟随重定向解析）
- 其余输入原样走单视频导入，单/批对调用方透明
- 未公开收藏夹需先登录（cookie 在后端）
"""

from app.bili.client import BiliClient
from app.core.link_parser import (
    SeriesRef,
    URL_RE,
    follow_redirects,
    parse_fav_id,
    parse_series_url,
    parse_video_url,
)
from app.services.importer import ImportService

_FAV_CAP = 200  # 单次批量导入上限


def _stop_any(url: str):
    return parse_fav_id(url) or parse_series_url(url) or parse_video_url(url)


async def submit_any(
    importer: ImportService, bili: BiliClient, text: str, playlist_id: int = 0
) -> dict:
    """智能提交：收藏夹/系列链接批量导入，否则单视频导入。"""
    text = (text or "").strip()
    if not text:
        raise ValueError("分享内容为空")

    fid = parse_fav_id(text)
    series: SeriesRef | None = None
    if fid is None:
        for url in URL_RE.findall(text):
            if parse_series_url(url):
                series = parse_series_url(url)
                break
            if parse_video_url(url):
                break  # 明链视频，直接走单视频，无需跳转
            try:
                final = await follow_redirects(bili.http, url, stop=_stop_any)
            except ValueError:
                continue
            fid = parse_fav_id(final)
            if fid:
                break
            series = parse_series_url(final)
            if series:
                break
            if parse_video_url(final):
                text = final  # 已解析到明链，单视频路径免二次跳转
                break

    if fid is not None:
        return await submit_fav(importer, bili, fid, playlist_id=playlist_id)
    if series is not None:
        return submit_series(importer, series, playlist_id=playlist_id)
    return {"mode": "single", "importId": importer.submit(text, playlist_id=playlist_id).id}


def submit_series(
    importer: ImportService, ref: SeriesRef, playlist_id: int = 0
) -> dict:
    """系列（合集）→ 一个后台容器导入任务（进度按视频数推进）。"""
    task = importer.submit_series(ref.sid, ref.mid, playlist_id=playlist_id)
    return {"mode": "series", "importId": task.id, "importIds": [task.id], "total": None}


async def submit_fav(
    importer: ImportService, bili: BiliClient, media_id: int, playlist_id: int = 0
) -> dict:
    folder = await bili.get_fav_folder_info(media_id)
    videos = await bili.get_fav_videos(media_id, cap=_FAV_CAP)
    if not videos:
        raise ValueError(
            "收藏夹为空、不存在或未公开（未公开收藏夹需要先在「账号」页扫码登录）"
        )
    tasks = [
        importer.submit_bvid(v["bvid"], playlist_id=playlist_id) for v in videos
    ]
    return {
        "mode": "batch",
        "folderTitle": folder.get("title") or f"收藏夹 {media_id}",
        "total": len(tasks),
        "importIds": [t.id for t in tasks],
    }
