"""#26 局域网发现：/api/discovery/ping 识别后端自身 + 桌面 lan 绑定语义。"""
import socket
import types

from app import embedded
from app.api.routes import _account_hash, discovery_ping


def _req(logged_in=True, mid=None):
    cookies = types.SimpleNamespace(logged_in=logged_in, get=lambda key: mid if key == "mid" else None)
    return types.SimpleNamespace(state=types.SimpleNamespace(cookies=cookies))


def test_ping_identifies_app_and_login_state():
    out = discovery_ping(_req(logged_in=True))
    assert out["app"] == "bilimusic"
    assert out["loggedIn"] is True and out["name"]
    assert discovery_ping(_req(logged_in=False))["loggedIn"] is False


def test_ping_reports_busy_and_account_hash(monkeypatch):
    """#29：自动连接靠 account 指纹认亲、靠 busy 优先连「正在放歌的那台」。"""
    from app.api import routes

    monkeypatch.setattr(routes.session_bus, "snapshot",
                        lambda mid: {"session": {"playing": True}})
    out = discovery_ping(_req(mid="12345"))
    assert out["busy"] is True
    assert out["account"] == _account_hash("12345")
    assert len(out["account"]) == 12 and out["account"] != "12345"


def test_ping_offline_when_not_logged_in():
    out = discovery_ping(_req(logged_in=False, mid=None))
    assert out["busy"] is False and out["account"] == ""


def test_ping_router_has_no_login_gate():
    """ping 不能挂在 /api 主路由的登录门禁下（探测发生在选定后端之前）。"""
    from app.api.routes import discovery_router
    deps = [d.dependency.__name__ for d in discovery_router.dependencies]
    assert deps == ["_require_token"]


def test_lan_socket_binds_wildcard_on_env_port(monkeypatch):
    monkeypatch.setenv("BM_PORT", "18123")
    sock = embedded.lan_socket()
    try:
        host, port = sock.getsockname()
        assert host == "0.0.0.0" and port == 18123
    finally:
        sock.close()


def test_lan_socket_falls_back_to_loopback_when_port_taken(monkeypatch):
    """端口被占（通配 blocker）→ lan_socket 必须回退 loopback 随机端口，本机照常可用。"""
    blocker = socket.socket()
    blocker.bind(("0.0.0.0", 0))   # 不带 SO_REUSEADDR：对带 REUSEADDR 的新 bind 仍是硬冲突
    blocker.listen(1)
    port = blocker.getsockname()[1]
    monkeypatch.setenv("BM_PORT", str(port))
    sock = embedded.lan_socket()
    try:
        host, bound = sock.getsockname()
        assert host == "127.0.0.1" and bound > 0 and bound != port
    finally:
        sock.close()
        blocker.close()
