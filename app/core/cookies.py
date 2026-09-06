"""B 站 Cookie 存储：设备指纹（buvid3/buvid4）与登录态（SESSDATA 等）。

明文 JSON 落盘但权限收紧为 0600，仅本机可读；面向个人自部署场景。
"""

import json
import os
import uuid
from pathlib import Path

LOGIN_COOKIE_NAMES = ("SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid")
ACCOUNT_METADATA = ("mid", "fav_folder_id")
LOGIN_KEYS = (*LOGIN_COOKIE_NAMES, "dedeuserid", "dedeuserid__ckmd5", *ACCOUNT_METADATA)


def login_cookies(items: dict[str, str]) -> dict[str, str]:
    """保留登录凭据，并兼容旧版误用的小写 DedeUserID。"""
    names = {name.lower(): name for name in LOGIN_COOKIE_NAMES}
    return {names[k.lower()]: v for k, v in items.items() if k.lower() in names and v}


def local_fingerprint() -> dict[str, str]:
    """SPI 接口不可用时的兜底：本地生成格式合法的 buvid。"""
    return {
        "buvid3": f"{str(uuid.uuid4()).upper()}infoc",
        "buvid4": str(uuid.uuid4()).upper(),
    }


class CookieStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path
        self._data: dict[str, str] = {}
        self.load()

    def repath(self, path: Path) -> None:
        """账号隔离：切换落盘路径并立即按新路径保存（内容不变）。"""
        self.path = path
        self.save()

    def load(self) -> None:
        if self.path is not None and self.path.exists():
            try:
                self._data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self._data = {}

    def save(self) -> None:
        if self.path is None:  # 登录候选只放内存，验证归属后才能写账号目录
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.chmod(self.path, 0o600)

    def all(self) -> dict[str, str]:
        return dict(self._data)

    def get(self, key: str) -> str | None:
        return self._data.get(key)

    def set_many(self, items: dict[str, str]) -> None:
        self._data.update({k: v for k, v in items.items() if v})
        self.save()

    def replace_login(self, items: dict[str, str]) -> None:
        """整组替换凭据及其派生身份，保留设备指纹。"""
        self._data = {k: v for k, v in self._data.items() if k not in LOGIN_KEYS}
        self._data.update(login_cookies(items))
        self.save()

    def pop(self, key: str) -> None:
        self._data.pop(key, None)
        self.save()

    @property
    def has_fingerprint(self) -> bool:
        return bool(self._data.get("buvid3"))

    @property
    def logged_in(self) -> bool:
        return bool(self._data.get("SESSDATA"))

    def clear_login(self) -> None:
        for k in LOGIN_KEYS:
            self._data.pop(k, None)
        self.save()
