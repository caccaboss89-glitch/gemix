#!/usr/bin/env python3
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

ALLOWED_PREFIXES = (Path("/workspace"), Path("/readonly"))
ALLOWED_PREFIXES_SET = {Path("/workspace"), Path("/readonly")}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
MEDIA_EXTS = VIDEO_EXTS | AUDIO_EXTS
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
SUBTITLE_EXTS = {".srt", ".vtt", ".ass"}


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def ensure_binary(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"Required binary '{name}' not found in PATH")
    return found


def resolve_path(value: str, *, must_exist: bool = False, allow_readonly_output: bool = False) -> Path:
    if not value:
        raise ValueError("Empty path")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"Path must be absolute: {value}")
    try:
        resolved = path.resolve(strict=False)
    except Exception:
        resolved = path
    if resolved not in ALLOWED_PREFIXES_SET and not any(p in resolved.parents for p in ALLOWED_PREFIXES):
        raise ValueError(f"Path must be under /workspace or /readonly: {value}")
    if not allow_readonly_output and (resolved == Path("/readonly") or Path("/readonly") in resolved.parents):
        if not must_exist:
            raise ValueError(f"Output cannot be under /readonly: {value}")
    if must_exist and not resolved.exists():
        raise FileNotFoundError(f"File not found: {resolved}")
    return resolved


def input_path(value: str) -> Path:
    return resolve_path(value, must_exist=True, allow_readonly_output=True)


def output_path(value: str) -> Path:
    p = resolve_path(value, must_exist=False, allow_readonly_output=False)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def temp_output_dir(value: str) -> Path:
    p = resolve_path(value, must_exist=False, allow_readonly_output=False)
    p.mkdir(parents=True, exist_ok=True)
    return p


def check_ext(path: Path, allowed: Sequence[str], label: str) -> None:
    if path.suffix.lower() not in set(allowed):
        raise ValueError(f"Unsupported {label} extension '{path.suffix}'. Allowed: {', '.join(sorted(allowed))}")


def parse_time(value: str) -> float:
    if value is None:
        raise ValueError("Missing time value")
    s = str(value).strip()
    if not s:
        raise ValueError("Empty time value")
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        return float(s)
    parts = s.split(":")
    if len(parts) not in (2, 3):
        raise ValueError(f"Invalid time '{value}'. Use seconds, MM:SS, or HH:MM:SS(.ms)")
    try:
        nums = [float(p) for p in parts]
    except ValueError as exc:
        raise ValueError(f"Invalid time '{value}'") from exc
    if len(nums) == 2:
        minutes, seconds = nums
        hours = 0.0
    else:
        hours, minutes, seconds = nums
    if minutes < 0 or minutes >= 60 or seconds < 0 or seconds >= 60:
        raise ValueError(f"Invalid time '{value}'")
    return hours * 3600 + minutes * 60 + seconds


def format_seconds(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds - hours * 3600 - minutes * 60
    return f"{hours:02d}:{minutes:02d}:{secs:06.3f}"


def run_cmd(cmd: Sequence[str], *, timeout: int = 120) -> subprocess.CompletedProcess:
    proc = subprocess.run(list(cmd), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(
            "Command failed (rc={}):\n{}\nSTDOUT:\n{}\nSTDERR:\n{}".format(
                proc.returncode, " ".join(str(c) for c in cmd), proc.stdout[-4000:], proc.stderr[-4000:]
            )
        )
    return proc


def ffprobe_json(path: Path, *, timeout: int = 60) -> Dict[str, Any]:
    ensure_binary("ffprobe")
    proc = run_cmd([
        "ffprobe", "-v", "error", "-show_format", "-show_streams", "-print_format", "json", str(path)
    ], timeout=timeout)
    try:
        return json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"ffprobe returned invalid JSON for {path}") from exc


def media_duration(path: Path) -> float:
    data = ffprobe_json(path)
    fmt = data.get("format") or {}
    duration = fmt.get("duration")
    if duration not in (None, "N/A"):
        try:
            return float(duration)
        except ValueError:
            pass
    durations: List[float] = []
    for stream in data.get("streams", []):
        d = stream.get("duration")
        if d not in (None, "N/A"):
            try:
                durations.append(float(d))
            except ValueError:
                pass
    return max(durations) if durations else 0.0


def has_video(path: Path) -> bool:
    data = ffprobe_json(path)
    return any(s.get("codec_type") == "video" for s in data.get("streams", []))


def has_audio(path: Path) -> bool:
    data = ffprobe_json(path)
    return any(s.get("codec_type") == "audio" for s in data.get("streams", []))


def stream_summary(path: Path) -> Dict[str, Any]:
    data = ffprobe_json(path)
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    out: Dict[str, Any] = {
        "file": str(path),
        "format_name": fmt.get("format_name"),
        "duration": float(fmt.get("duration", 0) or 0),
        "size_bytes": int(fmt.get("size", 0) or 0),
        "bit_rate": int(fmt.get("bit_rate", 0) or 0),
        "video": [],
        "audio": [],
        "subtitles": [],
    }
    for s in streams:
        kind = s.get("codec_type")
        dur_val = s.get("duration")
        bit_val = s.get("bit_rate")
        dur_float = None
        bit_int = None
        if dur_val is not None:
            try:
                dur_float = float(dur_val)
            except (ValueError, TypeError):
                pass
        if bit_val is not None:
            try:
                bit_int = int(bit_val)
            except (ValueError, TypeError):
                pass
        item = {
            "index": s.get("index"),
            "codec": s.get("codec_name"),
            "duration": dur_float,
            "bit_rate": bit_int,
        }
        if kind == "video":
            item.update({
                "width": s.get("width"),
                "height": s.get("height"),
                "pix_fmt": s.get("pix_fmt"),
                "r_frame_rate": s.get("r_frame_rate"),
                "avg_frame_rate": s.get("avg_frame_rate"),
                "rotation": rotation_degrees(s),
            })
            out["video"].append(item)
        elif kind == "audio":
            item.update({
                "sample_rate": int(s.get("sample_rate", 0) or 0),
                "channels": s.get("channels"),
                "channel_layout": s.get("channel_layout"),
            })
            out["audio"].append(item)
        elif kind == "subtitle":
            out["subtitles"].append(item)
    return out


def rotation_degrees(stream: Dict[str, Any]) -> int:
    tags = stream.get("tags") or {}
    side = stream.get("side_data_list") or []
    val = tags.get("rotate")
    if val is not None:
        try:
            return int(float(val)) % 360
        except ValueError:
            pass
    for item in side:
        if "rotation" in item:
            try:
                return int(float(item["rotation"])) % 360
            except ValueError:
                pass
    return 0


def write_json_report(data: Dict[str, Any], output: Optional[str]) -> None:
    payload = json.dumps(data, indent=2, ensure_ascii=False, default=str)
    if output:
        out = output_path(output)
        out.write_text(payload, encoding="utf-8")
        print(f"JSON written -> {out}")
    else:
        print(payload)


def quality_video_args(crf: int = 18, preset: str = "medium") -> List[str]:
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]


def quality_audio_args(bitrate: str = "192k") -> List[str]:
    return ["-c:a", "aac", "-b:a", bitrate]


def loudnorm_filter() -> str:
    return "loudnorm=I=-16:TP=-1.5:LRA=11"


def ffmpeg_overwrite_base() -> List[str]:
    ensure_binary("ffmpeg")
    return ["ffmpeg", "-hide_banner", "-y"]


def parse_resolution(value: str) -> Tuple[int, int]:
    m = re.fullmatch(r"(\d{1,5})x(\d{1,5})", value.strip().lower())
    if not m:
        raise ValueError(f"Invalid resolution '{value}'. Use WIDTHxHEIGHT, e.g. 1920x1080")
    w, h = int(m.group(1)), int(m.group(2))
    if w < 16 or h < 16:
        raise ValueError("Resolution too small")
    return w, h


def even_int(value: float) -> int:
    n = max(2, int(round(value)))
    return n if n % 2 == 0 else n - 1


def safe_concat_file(paths: Sequence[Path], list_path: Path) -> None:
    lines = []
    for p in paths:
        escaped = str(p).replace("\\", "\\\\").replace("'", "'\\'''")
        lines.append(f"file '{escaped}'")
    list_path.parent.mkdir(parents=True, exist_ok=True)
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def fail_main(exc: Exception) -> None:
    eprint(f"Error: {exc}")
    sys.exit(1)
