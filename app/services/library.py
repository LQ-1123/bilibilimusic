"""曲库查询与删除。"""

from sqlmodel import or_, select

from app.db.models import Album, Song
from app.db.session import new_session
from app.storage.files import FileStore


def list_songs(
    q: str = "", limit: int = 500, playlist_id: int = 0, only_collected: bool = True
) -> list[Song]:
    """playlist_id>0 时只返回该歌内的歌；0 返回全部。

    only_collected=True（默认）只返回真正「在曲库」的歌——#37 之后，多 P 合集的
    子作品默认 collected=False，只在合集容器里逐个收藏，不污染曲库。
    """
    with new_session() as session:
        stmt = select(Song).order_by(Song.created_at.desc()).limit(limit)
        if only_collected:
            stmt = stmt.where(Song.collected == True)  # noqa: E712
        if playlist_id:
            stmt = stmt.where(Song.playlist_id == playlist_id)  # type: ignore[attr-defined]
        if q.strip():
            kw = f"%{q.strip()}%"
            stmt = stmt.where(or_(Song.title.like(kw), Song.artist.like(kw)))
        return list(session.exec(stmt).all())


def get_album_by_source(bvid: str) -> Album | None:
    """#37：按源视频找已存在的合集容器（导入幂等，避免重复建容器）。

    v0.5.0：系列容器的 source_bvid 是 "sid:<id>" 前缀，与 bvid 天然不冲突。
    """
    with new_session() as session:
        return session.exec(select(Album).where(Album.source_bvid == bvid)).first()


def get_album(album_id: int) -> Album | None:
    with new_session() as session:
        return session.get(Album, album_id)


def rows_by_bvid(bvid: str) -> list[Song]:
    """该视频的全部分 P 行（系列导入幂等/认领散曲用）。"""
    with new_session() as session:
        return list(session.exec(select(Song).where(Song.bvid == bvid)))


def find_fav_folder_by_bvid(bvid: str) -> int:
    """同视频已有行记录过收藏位置 → 复用该夹 id（B 站收藏是视频级的，不重复请求）。"""
    with new_session() as session:
        row = session.exec(
            select(Song).where(Song.bvid == bvid, Song.fav_folder_id > 0)  # type: ignore[attr-defined]
        ).first()
        return row.fav_folder_id if row else 0


def claim_song_to_album(song_id: int, album_id: int, track_no: int, *,
                         title: str = "", duration: int = 0) -> None:
    """v0.5.0：把已存在的行（散曲/上次导入）挂进系列容器——收藏状态与歌单不动。

    换设备场景：sync 拉回的视频是散曲（album_id=0）；用户重建系列容器时
    这里把它们「认领」回容器（PRD 的 sid 重建 + 与收藏夹合并）。
    """
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is None:
            return
        song.album_id = album_id
        song.track_no = track_no
        if title:
            song.title = title
        if duration:
            song.duration = duration
        session.add(song)
        session.commit()


def uncollect_bvid_rows(bvid: str, album_id: int) -> list[int]:
    """把某视频在指定容器内的全部分 P 行退回「目录态」（collected=False）。

    系列的 B 站收藏是视频级的：取消收藏时同一视频的所有分 P 行要一起移出曲库，
    并清掉收藏位置记录（收藏已随之取消）。
    """
    with new_session() as session:
        rows = session.exec(
            select(Song).where(Song.bvid == bvid, Song.album_id == album_id)  # type: ignore[attr-defined]
        ).all()
        changed = []
        for song in rows:
            if song.collected or song.playlist_id or song.fav_folder_id:
                song.collected = False
                song.playlist_id = 0
                song.fav_folder_id = 0
                session.add(song)
                changed.append(song.id)
        session.commit()
        return changed


def collect_song(song_id: int, playlist_id: int = 0) -> Song | None:
    """#37：把合集里的某个子作品收藏进曲库。

    playlist_id 缺省时进默认歌单（「我的曲库」）——与普通导入一致，否则会落在
    「待归入」桶（playlist_id=0）里，侧栏「我的曲库」计数不涨。
    """
    if not playlist_id:
        from app.services import playlists as _pl  # 懒导入，避免与本模块的调用循环

        playlist_id = _pl.ensure_default().id or 0
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is None:
            return None
        song.collected = True
        song.playlist_id = playlist_id
        session.add(song)
        session.commit()
        session.refresh(song)
        return song


def get_song(song_id: int) -> Song | None:
    with new_session() as session:
        return session.get(Song, song_id)


def get_songs_by_ids(ids: list[int]) -> list[Song]:
    if not ids:
        return []
    with new_session() as session:
        return list(session.exec(select(Song).where(Song.id.in_(ids))))  # type: ignore[attr-defined]


def update_aid(song_id: int, aid: int) -> None:
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is not None and aid:
            song.aid = aid
            session.add(song)
            session.commit()


def update_fav_folder(song_id: int, folder_id: int) -> None:
    """记录歌曲所在的曲库夹；删歌取消收藏时直接定位。"""
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is not None and folder_id:
            song.fav_folder_id = folder_id
            session.add(song)
            session.commit()


def clear_fav_folder(song_id: int) -> None:
    """清零 fav_folder_id（收藏转移中标记）：对账据此区分「待推送」与「B 站已取消收藏」。"""
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is not None:
            song.fav_folder_id = 0
            session.add(song)
            session.commit()


def uncollect_song(song_id: int) -> bool:
    """#37：把子作品移出曲库（仍留在合集容器里，不取消 B 站收藏）。"""
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is None:
            return False
        song.collected = False
        song.playlist_id = 0
        session.add(song)
        session.commit()
        return True


def update_playlist(song_id: int, playlist_id: int) -> None:
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is not None and playlist_id:
            song.playlist_id = playlist_id
            session.add(song)
            session.commit()


def update_lyrics(song_id: int, lyrics: str, source: str) -> None:
    """写入歌词与来源，并置已尝试标记（lyrics 为空 = 取过但没取到，不再重试）。"""
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is None:
            return
        song.lyrics = lyrics
        song.lyrics_source = source
        song.lyrics_checked = 1
        session.add(song)
        session.commit()


def get_by_bvid(bvid: str) -> Song | None:
    with new_session() as session:
        return session.exec(select(Song).where(Song.bvid == bvid)).first()


def delete_song(song_id: int, files: FileStore | None) -> bool:
    with new_session() as session:
        song = session.get(Song, song_id)
        if song is None:
            return False
        session.delete(song)
        # 清理关联的分析缓存
        from app.db.models import TrackAnalysisRow

        row = session.get(TrackAnalysisRow, song_id)
        if row is not None:
            session.delete(row)
        session.commit()
        if files is not None:
            files.delete_song_files(song.audio_path, song.cover_path)
        return True
