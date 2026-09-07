from pathlib import Path
import io

from app.embedded import configure_data_dir, loopback_socket


def test_data_directory_is_created(tmp_path, monkeypatch):
    monkeypatch.delenv("BM_DATA_DIR", raising=False)
    path = configure_data_dir(str(tmp_path / "application"))
    assert path == tmp_path / "application"
    assert path.is_dir()


def test_socket_is_bound_to_loopback_and_owns_port():
    with loopback_socket() as sock:
        host, port = sock.getsockname()
        assert host == "127.0.0.1"
        assert port > 0


def test_parent_pipe_close_stops_backend(monkeypatch):
    from app import embedded
    stopped = []
    monkeypatch.setattr(embedded, "stop", lambda: stopped.append(True))
    embedded.watch_parent(io.StringIO(""))
    assert stopped == [True]


def test_concurrent_start_uses_one_backend(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import sys
    import threading
    import time
    import types
    import uvicorn
    from app import embedded

    release = threading.Event()
    ready = threading.Barrier(2)
    module = types.ModuleType("app.main")
    module.app = object()
    monkeypatch.setitem(sys.modules, "app.main", module)
    for name in ("_server", "_thread", "_url"):
        monkeypatch.setattr(embedded, name, None)

    class Server:
        def __init__(self, config):
            self.should_exit = False

        def run(self, sockets):
            release.wait(timeout=5)

    monkeypatch.setattr(uvicorn, "Server", Server)
    monkeypatch.setattr(embedded, "configure_data_dir", lambda directory: time.sleep(0.05))

    def launch():
        ready.wait()
        return embedded.start(str(tmp_path))

    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first, second = pool.submit(launch), pool.submit(launch)
            assert first.result() == second.result()
    finally:
        release.set()
        embedded.stop()
