"""SQLite 引擎与会话工厂。"""

from sqlmodel import Session, SQLModel, create_engine

from app.config import settings
from app.db.models import ImportTask, Song  # noqa: F401  (导入以注册表结构)

_engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)


def init_db() -> None:
    settings.ensure_dirs()
    SQLModel.metadata.create_all(_engine)
    _migrate()


def _migrate() -> None:
    """轻量迁移：给已有库补新列。

    列存在性通过 SQLAlchemy Inspector 检测；ALTER 语句为完全静态的
    DDL 常量，不含任何外部输入。
    """
    import sqlalchemy

    insp = sqlalchemy.inspect(_engine)
    if "song" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("song")}
    if "aid" not in cols:
        with _engine.begin() as conn:
            conn.exec_driver_sql("ALTER TABLE song ADD COLUMN aid INTEGER DEFAULT 0")


def new_session() -> Session:
    return Session(_engine)
