"""Verify a bundled executable can serve the application and static assets."""
import subprocess
import sys
import tempfile
import time
import urllib.request

with tempfile.TemporaryDirectory() as data:
    proc = subprocess.Popen([sys.argv[1], "--data-dir", data], stdout=subprocess.PIPE, text=True)
    try:
        line = proc.stdout.readline().strip()
        assert line.startswith("BILIMUSIC_URL="), line
        url = line.split("=", 1)[1]
        for attempt in range(120):
            try:
                with urllib.request.urlopen(url + "/openapi.json", timeout=1) as response:
                    assert response.status == 200
                break
            except OSError:
                if proc.poll() is not None:
                    raise RuntimeError("Backend exited before readiness")
                time.sleep(0.5)
        else:
            raise RuntimeError("Backend startup timeout")
        for path, expected in [("/", b"BiliMusic"), ("/static/app.js", b"playStream"), ("/static/style.css", b"m-tabs")]:
            with urllib.request.urlopen(url + path, timeout=20) as response:
                assert expected in response.read(), path
        print("Bundled backend smoke test passed")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
