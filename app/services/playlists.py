"""歌单 ⇆ 收藏夹：每个歌单对应 B 站账号下的公开收藏夹「bilimusic- <歌单名>」。

- 默认歌单「我的曲库」对应主夹「bilimusic」（历史溢出夹 bilimusic2… 也归它）
- 歌单改名 → 收藏夹同步改名（首夹用新名，溢出夹追加编号）
- 删歌 = 从所在夹取消收藏；收藏夹的 media_id 记在本地（Song.fav_folder_id）
- 账号下未被认领的 bilimusic 系夹由同步自动收养为歌单（换设备即恢复歌单结构）
"""

import asyncio
import json

from sqlmodel import select

from app.bili.client import (
    BiliClient,
    FAV_FOLDER_NAME,
    _FOLDER_RE,
    next_folder_title,
    playlist_folder_title,
    playlist_name_from_title,
)
from app.db.models import Playlist, Song
from app.db.session import new_session
from app.services import library

DEFAULT_NAME = "我的曲库"


# ---- 纯 helpers（单测覆盖） ----

def decode_folder_ids(raw: str) -> list[int]:
    try:
        ids = json.loads(raw or "[]")
    except ValueError:
        return []
    return [int(i) for i in ids] if isinstance(ids, list) else []


def encode_folder_ids(ids: list[int]) -> str:
    return json.dumps([int(i) for i in ids])


def playlist_folder_titles(name: str, count: int) -> list[str]:
    """歌单的夹名列表：首夹用歌单名，溢出夹追加编号（2 起）。"""
    base = playlist_folder_title(name)
    return [base] + [f"{base}{i}" for i in range(2, count + 1)]


def next_title_maker(name: str):
    """生成该歌单「全满时建新夹」的命名函数（闭包给 client.favorite_into）。"""
    if name == DEFAULT_NAME:
        return next_folder_title
    base = playlist_folder_title(name)

    def _next(existing: list[str]) -> str:
        taken = {t.strip().lower() for t in existing}
        n = 2
        while f"{base}{n}".lower() in taken:
            n += 1
        return f"{base}{n}"

    return _next


# ---- 查询/维护 ----

def list_playlists() -> list[Playlist]:
    with new_session() as session:
        return list(
            session.exec(select(Playlist).order_by(Playlist.created_at, Playlist.id)).all()
        )


def get_playlist(pid: int) -> Playlist | None:
    with new_session() as session:
        return session.get(Playlist, pid)


def get_default() -> Playlist | None:
    with new_session() as session:
        return session.exec(select(Playlist).where(Playlist.name == DEFAULT_NAME)).first()


def ensure_default() -> Playlist:
    """确保默认歌单存在，并把无主歌曲（playlist_id=0）归入其中。"""
    row = get_default()
    if row is None:
        with new_session() as session:
            row = Playlist(name=DEFAULT_NAME, folder_ids="[]")
            session.add(row)
            session.commit()
            session.refresh(row)
    _adopt_orphan_songs(row.id or 0)
    return row


def _adopt_orphan_songs(default_id: int) -> None:
    with new_session() as session:
        orphans = session.exec(select(Song).where(Song.playlist_id == 0)).all()  # type: ignore[attr-defined]
        if not orphans:
            return
        for song in orphans:
            song.playlist_id = default_id
            session.add(song)
        session.commit()


def folder_ids(p: Playlist) -> list[int]:
    return decode_folder_ids(p.folder_ids)


def set_folder_ids(pid: int, ids: list[int]) -> None:
    with new_session() as session:
        row = session.get(Playlist, pid)
        if row is not None:
            row.folder_ids = encode_folder_ids(ids)
            session.add(row)
            session.commit()


def remove_row(pid: int) -> None:
    """对账专用：B 站侧夹已消失，仅移除本地歌单行（歌曲已另行处理，不做 B 站操作）。"""
    with new_session() as session:
        row = session.get(Playlist, pid)
        if row is not None:
            session.delete(row)
            session.commit()


# ---- B 站联动操作 ----

async def create(name: str, bili: BiliClient, folder_id: int = 0) -> Playlist:
    """新建歌单：同步创建同名收藏夹（folder_id>0 供收养场景免建夹）。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("歌单名不能为空")
    with new_session() as session:
        exists = session.exec(select(Playlist).where(Playlist.name == name)).first()
        if exists:
            raise ValueError(f"歌单「{name}」已存在")
    if folder_id == 0:
        folder_id = await bili.create_fav_folder(playlist_folder_title(name))
    with new_session() as session:
        row = Playlist(name=name, folder_ids=encode_folder_ids([folder_id]))
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


async def add_song(pid: int, song_id: int, bili: BiliClient) -> dict:
    """把曲库内已有歌曲加入歌单（pid=0 → 默认歌单），并同步 B 站收藏转移。

    DB 的 playlist_id 是归属唯一事实源；B 站侧先从原夹取消收藏（失败不阻塞，
    后台同步会自愈），再收进目标歌单的夹组（满则溢出建夹）。
    """
    song = library.get_song(song_id)
    if song is None:
        raise ValueError("歌曲不存在")
    if pid:
        target = get_playlist(pid)
        if target is None:
            raise ValueError("歌单不存在")
    else:
        target = ensure_default()
    if song.playlist_id == (target.id or 0):
        return {"moved": False, "name": target.name}

    old_folder = song.fav_folder_id or 0
    # 先标记「转移中」（清零 fav_folder_id）：后台对账不会再把它当 B 站侧
    # 取消收藏而误删，而是视为待推送；收藏成功后回填新夹 id。
    library.clear_fav_folder(song.id)
    if old_folder:
        try:
            aid0 = song.aid or (await bili.bvid_to_aid(song.bvid) or 0)
            if aid0:
                await bili.unfavorite_song(aid0, old_folder)
        except Exception:  # noqa: BLE001  收藏转移失败不阻塞归属更新，后台同步自愈
            pass

    aid = song.aid or (await bili.bvid_to_aid(song.bvid) or 0)
    folder_id = 0
    if aid:
        ids = folder_ids(target)
        folder_id = (
            await bili.favorite_into(aid, ids, next_title_maker(target.name))
            if ids
            else await bili.favorite_song(aid)  # 默认夹池（含收养）
        )
    library.update_playlist(song.id, target.id or 0)
    if folder_id:
        library.update_fav_folder(song.id, folder_id)
    return {"moved": True, "name": target.name}


async def rename(pid: int, new_name: str, bili: BiliClient) -> None:
    """改歌单名，收藏夹名同步更新（首夹新名，溢出夹追加编号）。"""
    new_name = (new_name or "").strip()
    if not new_name:
        raise ValueError("歌单名不能为空")
    row = get_playlist(pid)
    if row is None or row.name == new_name:
        return
    ids = folder_ids(row)
    titles = playlist_folder_titles(new_name, len(ids))
    for fid, title in zip(ids, titles):
        await bili.rename_folder(fid, title)
    with new_session() as session:
        dbrow = session.get(Playlist, pid)
        if dbrow is not None:
            dbrow.name = new_name
            session.add(dbrow)
            session.commit()


# ---- 删除歌单（解放歌曲） ----

_move_jobs: set[int] = set()  # 正在后台转移收藏的歌单，防重复提交


async def delete(pid: int, bili: BiliClient) -> dict:
    """删除歌单：歌曲全部移入默认歌单（解放），对应 B 站收藏夹一并删除。

    本地移动立即生效；B 站侧的收藏转移（逐首补收藏进默认池）在后台按频控
    执行，中断由同步推送自愈。先删夹再转移，避免对账期间把歌单复活。
    返回 {"moved": 歌曲数, "folders": 删除的夹数}。
    """
    row = get_playlist(pid)
    if row is None:
        raise ValueError("歌单不存在")
    if row.name == DEFAULT_NAME:
        raise ValueError("默认歌单不能删除")
    if pid in _move_jobs:
        raise ValueError("该歌单正在删除中")
    _move_jobs.add(pid)
    try:
        default = ensure_default()
        ids = folder_ids(row)
        songs = library.list_songs(limit=5000, playlist_id=pid)

        # 本地立即解放：歌曲归入默认歌单、清零收藏位置（转移中标记），歌单行删除
        with new_session() as session:
            for s in songs:
                dbrow = session.get(Song, s.id)
                if dbrow is not None:
                    dbrow.playlist_id = default.id or 0
                    dbrow.fav_folder_id = 0
                    session.add(dbrow)
            folder_row = session.get(Playlist, pid)
            if folder_row is not None:
                session.delete(folder_row)
            session.commit()

        # B 站：先删夹（空了收藏语义由转移补上），避免对账复活歌单
        for fid in ids:
            try:
                await bili.delete_folder(fid)
            except BiliApiError:
                pass  # 夹可能已被手动删除

        # 后台把歌曲的收藏逐首转移进默认池（频控），不阻塞删除响应
        if songs:
            asyncio.create_task(_transfer_favorites(bili, [s.id for s in songs]))
        return {"moved": len(songs), "folders": len(ids)}
    finally:
        _move_jobs.discard(pid)


async def _transfer_favorites(bili: BiliClient, song_ids: list[int]) -> None:
    """把解放的歌曲收藏逐首转移到默认池（主夹 bilimusic）。单首失败由同步自愈。"""
    for sid in song_ids:
        song = library.get_song(sid)
        if song is None:
            continue
        try:
            aid = song.aid
            if not aid:
                aid = await bili.bvid_to_aid(song.bvid) or 0
                if aid:
                    library.update_aid(song.id, aid)
            if not aid:
                continue
            fid = await bili.favorite_song(aid)
            library.update_fav_folder(song.id, fid)
        except Exception:  # noqa: BLE001
            pass
        await asyncio.sleep(1.2)


async def adopt_folders(bili: BiliClient) -> int:
    """收养账号下未被认领的 bilimusic 系收藏夹（换设备恢复歌单结构）。

    「bilimusic- X」→ 建歌单 X；「bilimusic」与其编号溢出夹 → 归默认歌单。
    返回收养的夹数。
    """
    ensure_default()
    folders = await bili.list_library_folders()
    known: set[int] = set()
    for p in list_playlists():
        known |= set(folder_ids(p))

    adopted = 0
    default = get_default()
    default_ids = folder_ids(default)
    for f in folders:
        if f["id"] in known:
            continue
        name = playlist_name_from_title(f["title"])
        if name:
            try:
                await create(name, bili, folder_id=f["id"])
                adopted += 1
            except ValueError:
                continue  # 同名歌单已存在（夹被重复收养的极端情况）
        elif f["title"].strip().lower() == FAV_FOLDER_NAME:
            if f["id"] not in default_ids:
                default_ids.insert(0, f["id"])
                adopted += 1
        elif _FOLDER_RE.match(f["title"]):  # 编号溢出夹 → 默认歌单
            if f["id"] not in default_ids:
                default_ids.append(f["id"])
                adopted += 1
    if adopted and default_ids != folder_ids(default):
        set_folder_ids(default.id, default_ids)
    return adopted
