"""Run from the repository root with packaging dependencies installed."""
import subprocess
import sys
from pathlib import Path

subprocess.run([
    sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "bilimusic-backend", "--paths", ".",
    "--distpath", "desktop/backend", "--workpath", "build/pyinstaller",
    "--specpath", "build", "--collect-all", "app", "--collect-all", "sqlmodel",
    "--collect-all", "uvicorn", "--collect-all", "sqlalchemy",
    "--collect-all", "qrcode", "--hidden-import", "PIL.Image",
    "--add-data", f"{Path('app/web').resolve()}:app/web", "packaging/backend-entry.py",
], check=True)
