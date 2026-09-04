"""曲库查询与删除。"""

from sqlmodel import or_, select

from app.db.models import Song
from app.db.session import new_session
from app.storage.files import FileStore


def list_songs(q: str = "", limit: int = 500) -> list[Song]:
    with new_session() as session:
        stmt = select(Song).order_by(Song.created_at.desc()).limit(limit)
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


def get_by_bvid(bvid: str) -> Song | None:
    with new_session() as session:
        return session.exec(select(Song).where(Song.bvid == bvid)).first()


def delete_song(song_id: int, files: FileStore) -> bool:
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
        files.delete_song_files(song.audio_path, song.cover_path)
        return True
