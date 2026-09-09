"""运行配置：全部支持环境变量覆盖，默认面向个人局域网部署。"""

import os
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent

_TRUE = ("1", "true", "on", "yes")
_FALSE = ("0", "false", "off", "no", "")


def _flag(name: str, default: str) -> bool:
    """环境变量布尔开关：缺省用 default，无法识别时也按 default。"""
    raw = os.getenv(name, default).strip().lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    return default.strip().lower() in _TRUE


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

        # 歌词严格模式（宁缺毋滥）：外部歌词源必须通过置信度校验才采纳，
        # 过不了就继续降级而不是显示错配结果。设 BM_LYRICS_STRICT=0 放宽。
        self.lyrics_strict: bool = _flag("BM_LYRICS_STRICT", "1")
        # 网易云（非官方接口）默认关闭：实测错配率高（同名翻唱/另一首歌），
        # 需要时用 BM_LYRICS_NETEASE=1 打开。
        self.lyrics_netease: bool = _flag("BM_LYRICS_NETEASE", "0")

    def ensure_dirs(self) -> None:
        for d in (self.data_dir, self.music_dir, self.cover_dir):
            d.mkdir(parents=True, exist_ok=True)


settings = Settings()
