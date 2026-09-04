"""数据库模型与引擎（SQLite + SQLModel）。"""

from datetime import datetime

from sqlmodel import Field, SQLModel


class Playlist(SQLModel, table=True):
    """歌单：每个歌单对应 B 站账号下的公开收藏夹「bilimusic- <歌单名>」。

    folder_ids 为 JSON 数组文本：[主夹 media_id, 溢出夹…]；
    主夹名随歌单改名同步更新，溢出夹在主夹满 2000 条后自动创建。
    """

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True)
    folder_ids: str = "[]"
    created_at: datetime = Field(default_factory=datetime.utcnow)


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
    cover_color: str = ""  # 封面主色（#rrggbb），球海 UI 的球体颜色
    source_url: str = ""
    lyrics: str = ""  # 歌词文本：带 [mm:ss.xx] 时间轴的 LRC，或无轴纯文本；空 = 未取到
    lyrics_source: str = ""  # 歌词来源：cc（B站人工字幕）/ lrclib / ai（B站AI字幕）
    lyrics_checked: int = 0  # 已尝试取词标记：取不到也置 1，避免反复打外部接口
    fav_folder_id: int = 0  # 所在曲库夹（bilimusic 系）的 media_id；删歌取消收藏用
    playlist_id: int = 0  # 所属歌单；0 表示待归入默认歌单
    created_at: datetime = Field(default_factory=datetime.utcnow)


class RecPool(SQLModel, table=True):
    """推荐池：滚动链接组。只存元数据不下载音频，过期即删（懒清理）。

    采集搭车在听歌上——播放器起播后以当前歌为种子拉 B 站相关视频，
    频控（同种子未过期不重复、全局最小间隔、每日上限）在 service 层。
    """

    id: int | None = Field(default=None, primary_key=True)
    bvid: str = Field(unique=True, index=True)
    title: str
    artist: str = ""
    duration: int = 0  # 秒
    cover_url: str = ""
    seed_bvid: str = ""  # 由哪首歌推荐而来
    genre: str = ""  # 风格分类：摇滚/R&B/流行/民谣/说唱/电子/古风/爵士；空 = 未归类
    added_at: datetime = Field(default_factory=datetime.utcnow)
    expires_at: datetime = Field(default_factory=datetime.utcnow, index=True)


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
