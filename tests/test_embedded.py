from pathlib import Path

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
