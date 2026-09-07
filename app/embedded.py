"""Shared entry point for bundled desktop and Android runtimes."""

import os
from pathlib import Path
import socket
import threading

_server = None
_thread = None
_url = None
_start_lock = threading.Lock()


def configure_data_dir(directory: str) -> Path:
    path = Path(directory).resolve()
    path.mkdir(parents=True, exist_ok=True)
    os.environ["BM_DATA_DIR"] = str(path)
    return path


def loopback_socket():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    return sock


def start(directory: str) -> str:
    with _start_lock:
        return _start(directory)


def _start(directory: str) -> str:
    global _server, _thread, _url
    if _thread and _thread.is_alive():
        return _url
    configure_data_dir(directory)
    import uvicorn
    from app.main import app

    sock = loopback_socket()
    _url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    _server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", loop="asyncio", http="h11", ws="none",
        access_log=False, log_level="warning", timeout_graceful_shutdown=3,
    ))
    server = _server

    def run():
        try:
            server.run(sockets=[sock])
        finally:
            sock.close()

    _thread = threading.Thread(target=run, name="bilimusic-backend", daemon=True)
    _thread.start()
    return _url


def stop():
    if _server:
        _server.should_exit = True
    if _thread:
        _thread.join(timeout=5)


def watch_parent(stream):
    stream.read()
    stop()


def main():
    import argparse
    import signal
    import time
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--watch-parent-stdin", action="store_true")
    args = parser.parse_args()
    url = start(args.data_dir)
    if args.watch_parent_stdin:
        threading.Thread(target=watch_parent, args=(sys.stdin,), daemon=True).start()
    print("BILIMUSIC_URL=" + url, flush=True)
    signal.signal(signal.SIGTERM, lambda *_: stop())
    signal.signal(signal.SIGINT, lambda *_: stop())
    while _thread.is_alive():
        time.sleep(0.2)
    if not _server.started:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
