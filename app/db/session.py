"""SQLite 引擎与会话工厂（账号隔离版：每个 B 站 mid 一套独立数据库）。

- 引擎按 mid 缓存；请求及其后台任务绑定账号，切换不会改变进行中任务的归属
- legacy 库只在确认原账号身份后迁移，新登录账号不会自动继承他人数据
"""

import os
import shutil
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

from sqlmodel import Session, SQLModel, create_engine

from app.config import settings
from app.db.models import Album, ImportTask, Song  # noqa: F401  (导入以注册表结构)

_engines: dict[str, object] = {}
_current_mid: str | None = None  # None = 待定库（legacy 路径 data/bilibili_music.db）
_account_context: ContextVar[tuple[str | None] | None] = ContextVar("database_account", default=None)


@contextmanager
def account_scope(mid: str | None):
    """在 async 请求、子任务和线程池中保留开始工作时的账号。"""
    token = _account_context.set((mid,))
    try:
        yield
    finally:
        _account_context.reset(token)


def accounts_dir() -> Path:
    return settings.data_dir / "accounts"


def account_db_path(mid: str) -> Path:
    return accounts_dir() / str(mid) / "bilimusic.db"


def account_cookie_path(mid: str) -> Path:
    return accounts_dir() / str(mid) / "cookies.json"


def active_mid_file() -> Path:
    return settings.data_dir / "active_mid"


def active_mid() -> str | None:
    return _current_mid


def _get_engine(mid: str | None):
    key = mid or "_pending"
    eng = _engines.get(key)
    if eng is None:
        path = settings.db_path if mid is None else account_db_path(mid)
        path.parent.mkdir(parents=True, exist_ok=True)
        eng = create_engine(
            f"sqlite:///{path}",
            connect_args={"check_same_thread": False},
        )
        _engines[key] = eng
    return eng


def _init_engine(engine) -> None:
    SQLModel.metadata.create_all(engine)
    _migrate(engine)


def init_db() -> None:
    settings.ensure_dirs()
    _init_engine(_get_engine(None))


def _migrate(engine) -> None:
    """轻量迁移：给已有库补新列。

    列存在性通过 SQLAlchemy Inspector 检测；ALTER 语句为完全静态的
    DDL 常量，不含任何外部输入。
    """
    import sqlalchemy

    insp = sqlalchemy.inspect(engine)
    if "song" not in insp.get_table_names():
        return
    # SQLite cannot drop the implicit index created by `bvid UNIQUE`; rebuild
    # the table once so paged entries can share a bvid while keeping the data.
    song_indexes = insp.get_indexes("song")
    has_legacy_unique = any(i.get("unique") and i.get("column_names") == ["bvid"] for i in song_indexes)
    with engine.connect() as probe:
        for row in probe.exec_driver_sql("PRAGMA index_list('song')").fetchall():
            if bool(row[2]):
                cols_for_index = [r[2] for r in probe.exec_driver_sql(f'PRAGMA index_info("{row[1]}")').fetchall()]
                has_legacy_unique = has_legacy_unique or cols_for_index == ["bvid"]
    table_sql = engine.connect().exec_driver_sql("SELECT sql FROM sqlite_master WHERE type='table' AND name='song'").scalar()
    has_inline_unique = isinstance(table_sql, str) and "bvid VARCHAR UNIQUE" in table_sql.upper()
    if has_legacy_unique or has_inline_unique:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song RENAME TO song_legacy_migration")
            Song.__table__.create(conn)
            old_cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info('song_legacy_migration')").fetchall()}
            new_cols = [c.name for c in Song.__table__.columns]
            defaults = {"aid": "0", "cover_color": "''", "fav_folder_id": "0", "playlist_id": "0",
                        "lyrics": "''", "lyrics_source": "''", "lyrics_checked": "0", "album_id": "0", "track_no": "0"}
            source = [f'"{c}"' if c in old_cols else defaults.get(c, "NULL") for c in new_cols]
            quoted = ", ".join(f'"{c}"' for c in new_cols)
            conn.exec_driver_sql(f'INSERT INTO song ({quoted}) SELECT {", ".join(source)} FROM song_legacy_migration')
            conn.exec_driver_sql("DROP TABLE song_legacy_migration")
        insp = sqlalchemy.inspect(engine)
    cols = {c["name"] for c in insp.get_columns("song")}
    if "aid" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN aid INTEGER DEFAULT 0")
    if "cover_color" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN cover_color VARCHAR DEFAULT ''")
    if "fav_folder_id" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN fav_folder_id INTEGER DEFAULT 0")
    if "playlist_id" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN playlist_id INTEGER DEFAULT 0")
    if "lyrics" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN lyrics TEXT DEFAULT ''")
    if "lyrics_source" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN lyrics_source VARCHAR DEFAULT ''")
    if "lyrics_checked" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN lyrics_checked INTEGER DEFAULT 0")
    if "album_id" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN album_id INTEGER DEFAULT 0")
    if "track_no" not in cols:
        with engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN track_no INTEGER DEFAULT 0")
    # Replace the legacy bvid-only uniqueness with the paged-video key.
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_song_bvid_cid ON song (bvid, cid)"
        )
    # 存量 CDN 封面 http→https：打包端 WKWebView/ATS 与 Android 明文策略拦截 http 图片
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "UPDATE song SET cover_path = 'https://' || substr(cover_path, 8) "
            "WHERE cover_path LIKE 'http://%'"
        )
        if "recpool" in insp.get_table_names():
            conn.exec_driver_sql(
                "UPDATE recpool SET cover_url = 'https://' || substr(cover_url, 8) "
                "WHERE cover_url LIKE 'http://%'"
            )


def new_session() -> Session:
    bound = _account_context.get()
    return Session(_get_engine(bound[0] if bound is not None else _current_mid))


def context_mid() -> str | None:
    """当前请求/后台任务绑定的账号（无绑定时回退全局当前账号）。"""
    bound = _account_context.get()
    return bound[0] if bound is not None else _current_mid


def prepare_account(mid: int | str, *, inherit_legacy: bool = False) -> Path:
    """准备目标库；只有已核验的 legacy 原账号可以继承存量，不改变当前账号。"""
    mid = str(mid)
    if not mid.isascii() or not mid.isdigit() or int(mid) <= 0:
        raise ValueError("mid 必须是正整数")
    target = account_db_path(mid)
    if not target.exists():
        legacy = Path(settings.db_path)
        claimed = legacy.with_name(legacy.name + ".claimed")
        if inherit_legacy and legacy.exists() and not claimed.exists():
            pending_engine = _engines.pop("_pending", None)
            if pending_engine is not None:
                pending_engine.dispose()
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(legacy, target)
            os.replace(legacy, claimed)  # 封存：后续新账号不再继承
    _init_engine(_get_engine(mid))
    return accounts_dir() / mid


def activate_account(mid: int | str) -> Path:
    """目标库及标记写入成功后才发布当前账号。"""
    global _current_mid
    mid = str(mid)
    account_dir = prepare_account(mid)
    marker = active_mid_file()
    pending = marker.with_suffix(".tmp")
    pending.write_text(mid, encoding="utf-8")
    os.replace(pending, marker)
    _current_mid = mid
    return account_dir


def load_active_account() -> str | None:
    """启动时读取上次激活的账号标记；目录齐备则恢复激活，否则回到待定库。"""
    global _current_mid
    _current_mid = None
    f = active_mid_file()
    if not f.exists():
        return None
    mid = f.read_text(encoding="utf-8").strip()
    if mid.isascii() and mid.isdigit() and int(mid) > 0 and account_db_path(mid).exists():
        _current_mid = mid
        _init_engine(_get_engine(mid))
        return mid
    return None


def reset_to_pending(*, clear_marker: bool = True) -> None:
    """退出登录回到待定库（等待下一次登录再激活）。"""
    global _current_mid
    _current_mid = None
    if clear_marker and active_mid_file().exists():
        active_mid_file().unlink()
