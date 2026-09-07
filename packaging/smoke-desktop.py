"""Launch the native Tauri WebView and verify backend cleanup on exit."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import psutil

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    marker = root / "ready"
    env = dict(os.environ, BM_DESKTOP_SMOKE=str(marker), BM_DESKTOP_DATA_DIR=str(root))
    proc = subprocess.Popen([str(Path(sys.argv[1]).resolve())], env=env)
    try:
        proc.wait(timeout=180)
        assert proc.returncode == 0, f"Desktop exited with {proc.returncode}"
        assert marker.read_text() == "native-webview-ready", "Native WebView did not load the local app"
        backend_pid = int(marker.with_suffix(".pid").read_text())
        for _ in range(30):
            if not psutil.pid_exists(backend_pid):
                break
            time.sleep(0.1)
        assert not psutil.pid_exists(backend_pid), "Backend process remained after window exit"
        print("Tauri native WebView and backend lifecycle smoke test passed")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        if (root / "backend.log").exists():
            print((root / "backend.log").read_text(errors="replace")[-5000:])
