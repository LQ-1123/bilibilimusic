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
