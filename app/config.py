"""运行配置：全部支持环境变量覆盖，默认面向个人局域网部署。"""

import os
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent


class Settings:
    def __init__(self) -> None:
        self.host: str = os.getenv("BM_HOST", "0.0.0.0")
        self.port: int = int(os.getenv("BM_PORT", "8000"))

        self.data_dir = Path(os.getenv("BM_DATA_DIR", _PROJECT_ROOT / "data"))
        self.db_path = self.data_dir / "bilibili_music.db"
        self.music_dir = self.data_dir / "music"
        self.cover_dir = self.data_dir / "covers"
        self.cookie_path = self.data_dir / "cookies.json"

        # 为空则 API 不做鉴权（个人局域网默认）；设置后 /api/* 需要 Bearer Token，
        # 媒体流接口也接受 ?token= 查询参数以便 <audio> 标签直接引用。
        self.api_token: str = os.getenv("BM_API_TOKEN", "")

        self.allow_origins: list[str] = [
            o.strip() for o in os.getenv("BM_ALLOW_ORIGINS", "*").split(",") if o.strip()
        ]

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.music_dir, self.cover_dir):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()
