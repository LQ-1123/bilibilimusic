"""曲库查询与删除。"""

from sqlmodel import or_, select

from app.db.models import Song
from app.db.session import new_session
from app.storage.files import FileStore


def list_songs(q: str = "", limit: int = 500, playlist_id: int = 0) -> list[Song]:
    """playlist_id>0 时只返回该歌内的歌；0 返回全部。"""
    with new_session() as session:
        stmt = select(Song).order_by(Song.created_at.desc()).limit(limit)
        if playlist_id:
            stmt = stmt.where(Song.playlist_id == playlist_id)  # type: ignore[attr-defined]
        if q.strip():
            kw = f"%{q.strip()}%"
            stmt = stmt.where(or_(Song.title.like(kw), Song.artist.like(kw)))
        return list(session.exec(stmt).all())


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
