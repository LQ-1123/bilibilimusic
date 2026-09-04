"""URL 安全校验单测。"""

import pytest

from app.core import url_guard
from app.core.url_guard import BILIBILI_SUFFIXES, UnsafeUrlError, validate_bilibili_url, validate_url


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    """单测不联网：域名解析统一返回公网 IP；真实解析逻辑另有 e2e 验证。"""
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: ("1.2.3.4",))


def test_only_http_https():
    with pytest.raises(UnsafeUrlError):
        validate_url("ftp://example.com/x")
    with pytest.raises(UnsafeUrlError):
        validate_url("file:///etc/passwd")


def test_reject_private_and_reserved_ips():
    for url in (
        "http://127.0.0.1:8000/x",
        "https://192.168.1.10/x",
        "https://10.0.0.2/x",
        "https://172.16.0.9/x",
        "https://169.254.169.254/latest/meta-data",
        "https://0.0.0.0/",
        "https://[::1]/x",
        "https://[::ffff:10.0.0.2]/x",
        "https://224.0.0.1/x",
    ):
        with pytest.raises(UnsafeUrlError):
            validate_url(url)


def test_reject_localhost_names():
    for url in ("http://localhost/x", "https://api.localhost/x", "https://nas.local/x"):
        with pytest.raises(UnsafeUrlError):
            validate_url(url)


def test_dns_resolving_to_private_rejected(monkeypatch):
    monkeypatch.setattr(url_guard, "_resolve_ips", lambda host: ("192.168.0.1",))
    with pytest.raises(UnsafeUrlError):
        validate_url("https://rebind.example.com/x")


def test_bilibili_allowlist():
    ok = validate_bilibili_url("https://www.bilibili.com/video/BV1xx411c7mD")
    assert ok.startswith("https://www.bilibili.com")
    assert validate_bilibili_url("https://b23.tv/abc123")
    assert validate_bilibili_url("https://i0.hdslb.com/bfs/cover.jpg")
    assert validate_bilibili_url("https://upos-sz-mirrorakam.akamaized.net/media/x.m4s")
    assert validate_bilibili_url("https://upos-sz-mirrorcos.bilivideo.com/media/x.m4s")

    with pytest.raises(UnsafeUrlError):
        validate_bilibili_url("https://evil.com/x")
    with pytest.raises(UnsafeUrlError):
        # 伪装成白名单后缀的域名字符串
        validate_bilibili_url("https://evil.com/?u=bilibili.com")


def test_allowlist_boundary():
    # notbilibili.com 不应命中 bilibili.com 后缀
    with pytest.raises(UnsafeUrlError):
        validate_url("https://notbilibili.com/x", suffix_allowlist=BILIBILI_SUFFIXES)
