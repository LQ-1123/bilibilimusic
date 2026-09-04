"""数据库模型与引擎（SQLite + SQLModel）。"""

from datetime import datetime

from sqlmodel import Field, SQLModel


class Song(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    bvid: str = Field(index=True, unique=True)
    aid: int = 0  # av 号：收藏夹导出（fav/deal）需要；旧数据在导出时懒补
    cid: int
    title: str
    artist: str
    duration: int = 0  # 秒
    quality_id: int = 0
    audio_path: str
    cover_path: str
    source_url: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)


class ImportTask(SQLModel, table=True):
    id: str = Field(primary_key=True)
    source_url: str = ""
    status: str = "pending"  # pending / resolving / downloading / ready / failed
    progress: int = 0  # 0-100
    error: str | None = None
    song_id: int | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)


class TrackAnalysisRow(SQLModel, table=True):
    """Smart Transition 的分析缓存；version/duration 变化即失效重分析。"""

    song_id: int = Field(primary_key=True)
    bvid: str = Field(index=True)
    duration: float = 0
    version: int = 0
    data: str  # TrackAnalysis JSON
    created_at: datetime = Field(default_factory=datetime.utcnow)
