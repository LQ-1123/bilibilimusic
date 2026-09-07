"""Normalize Tauri artifact filenames used by Release documentation."""
import json
from pathlib import Path
import shutil
import sys

version = json.loads(Path("desktop/package.json").read_text())["version"]
os_name, arch = sys.argv[1:]
extension = "dmg" if os_name == "mac" else "exe"
source = Path("desktop/src-tauri/target/release/bundle")
matches = list(source.glob(f"**/*.{extension}"))
if len(matches) != 1:
    raise SystemExit(f"Expected one {extension} installer, found {matches}")
target = Path("desktop/dist")
target.mkdir(parents=True, exist_ok=True)
shutil.copy2(matches[0], target / f"BiliMusic-{version}-{os_name}-{arch}.{extension}")
