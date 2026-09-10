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


DISCOVERY_PORT_DEFAULT = 8000   # #26：局域网发现的约定端口（Android 扫描端同此值）


def lan_socket() -> socket.socket:
    """#26 桌面端：绑 0.0.0.0 + 固定端口，手机在同网段扫该端口即可发现本机。

    端口被占用（第二实例/别的应用）时回退 loopback 随机端口——本机照常可用，
    只是当局域网不可发现。Android 侧不用本函数（手机后端不对外暴露）。
    """
    port = int(os.getenv("BM_PORT", str(DISCOVERY_PORT_DEFAULT)))
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", port))
        sock.listen(128)
        return sock
    except OSError:
        sock.close()
        return loopback_socket()


def start(directory: str, lan: bool = False) -> str:
    with _start_lock:
        return _start(directory, lan)


def _start(directory: str, lan: bool = False) -> str:
    global _server, _thread, _url
    if _thread and _thread.is_alive():
        return _url
    configure_data_dir(directory)
    import uvicorn
    from app.main import app

    sock = lan_socket() if lan else loopback_socket()
    # 对本机 Web/桌面壳永远宣告 127.0.0.1 形式（0.0.0.0 绑定同样接受 loopback 连接；
    # desktop 壳的 policy.rs 也只认 127.0.0.1 宣告）
    _url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    _server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", loop="asyncio", http="h11", ws="none",
        access_log=False, log_level="warning", timeout_graceful_shutdown=1,
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
        # #25：等 1.5s 让 uvicorn 收尾（含在飞请求）；超时直接硬退，避免 main() 里空转
        _thread.join(timeout=1.5)
        if _thread.is_alive():
            os._exit(0)


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
    # #26：桌面壳传 --lan，绑 0.0.0.0 固定端口，手机端可在局域网发现本机
    parser.add_argument("--lan", action="store_true")
    args = parser.parse_args()
    url = start(args.data_dir, lan=args.lan)
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
