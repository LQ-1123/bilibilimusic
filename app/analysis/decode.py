"""音频解码：m4a/AAC → 单声道 float32 @ 11.025kHz。

分析专用低采样率：BPM / 能量 / 频谱特征已经足够（规范第二十八节），
原始 AAC 仍以原质量播放，互不影响。
优先 ffmpeg；不可用时回退 macOS 自带的 afconvert。
"""

import os
import shutil
import subprocess
import tempfile
import wave

import numpy as np

TARGET_SR = 11025


class DecodeError(Exception):
    pass


def decode_mono(file_path: str, sr: int = TARGET_SR) -> np.ndarray:
    """解码为 mono float32（范围 -1..1）。"""
    if shutil.which("ffmpeg"):
        try:
            proc = subprocess.run(
                [
                    "ffmpeg", "-v", "error", "-i", file_path,
                    "-ac", "1", "-ar", str(sr), "-f", "f32le", "-",
                ],
                capture_output=True,
                timeout=60,
            )
            if proc.returncode == 0 and proc.stdout:
                return np.frombuffer(proc.stdout, dtype=np.float32).copy()
        except (subprocess.TimeoutExpired, OSError):
            pass
    if shutil.which("afconvert"):
        return _decode_with_afconvert(file_path, sr)
    raise DecodeError("没有可用的音频解码器（需要 ffmpeg 或 afconvert）")


def _decode_with_afconvert(file_path: str, sr: int) -> np.ndarray:
    fd, tmp_path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        proc = subprocess.run(
            [
                "afconvert", "-f", "WAVE", "-d", f"LEI16@{sr}", "-c", "1",
                file_path, tmp_path,
            ],
            capture_output=True,
            timeout=60,
        )
        if proc.returncode != 0:
            raise DecodeError(f"afconvert 失败：{proc.stderr[:200]!r}")
        with wave.open(tmp_path, "rb") as w:
            raw = w.readframes(w.getnframes())
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    except (subprocess.TimeoutExpired, OSError, wave.Error) as exc:
        raise DecodeError(f"afconvert 解码异常：{exc}") from exc
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
