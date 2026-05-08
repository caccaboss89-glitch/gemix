#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

from av_utils import AUDIO_EXTS, IMAGE_EXTS, MEDIA_EXTS, SUBTITLE_EXTS, VIDEO_EXTS, fail_main, input_path, run_cmd, stream_summary, temp_output_dir, write_json_report


def _silence_detect(path: Path, noise: str, min_duration: float, timeout: int) -> List[Dict[str, Any]]:
    proc = run_cmd([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", f"silencedetect=noise={noise}:d={min_duration}", "-f", "null", "-"
    ], timeout=timeout)
    events: List[Dict[str, Any]] = []
    current: Dict[str, Any] = {}
    for line in proc.stderr.splitlines():
        if "silence_start:" in line:
            try:
                current = {"start": float(line.rsplit("silence_start:", 1)[1].strip())}
            except ValueError:
                current = {}
        elif "silence_end:" in line:
            try:
                import re
                end_match = re.search(r"silence_end:\s*([\d.]+)", line)
                dur_match = re.search(r"silence_duration:\s*([\d.]+)", line)
                if end_match and dur_match:
                    current["end"] = float(end_match.group(1))
                    current["duration"] = float(dur_match.group(1))
                    events.append(current)
                    current = {}
            except Exception:
                continue
    return events


def _black_detect(path: Path, threshold: float, min_duration: float, timeout: int) -> List[Dict[str, Any]]:
    proc = run_cmd([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-vf", f"blackdetect=d={min_duration}:pix_th={threshold}", "-an", "-f", "null", "-"
    ], timeout=timeout)
    events: List[Dict[str, Any]] = []
    for line in proc.stderr.splitlines():
        if "black_start:" not in line:
            continue
        item: Dict[str, Any] = {}
        for key in ("black_start", "black_end", "black_duration"):
            marker = key + ":"
            if marker in line:
                try:
                    after = line.split(marker, 1)[1].split()[0]
                    item[key.replace("black_", "")] = float(after)
                except Exception:
                    pass
        if item:
            events.append(item)
    return events


def _thumbnails(path: Path, output_dir: Path, count: int, timeout: int) -> List[str]:
    count = max(1, min(count, 12))
    pattern = output_dir / "thumb_%03d.jpg"
    run_cmd([
        "ffmpeg", "-hide_banner", "-y", "-i", str(path),
        "-vf", f"fps={count}/max(duration,1),scale='min(640,iw)':-2",
        "-frames:v", str(count), "-q:v", "3", str(pattern)
    ], timeout=timeout)
    return [str(p) for p in sorted(output_dir.glob("thumb_*.jpg"))]


def inspect(args: argparse.Namespace) -> Dict[str, Any]:
    path = input_path(args.input)
    if path.suffix.lower() not in MEDIA_EXTS:
        raise ValueError(f"Unsupported media file: {path.suffix}. Allowed: {', '.join(sorted(MEDIA_EXTS))}")
    report = stream_summary(path)
    report["extension_kind"] = "video" if path.suffix.lower() in VIDEO_EXTS else "audio"
    report["warnings"] = []
    if not report["video"] and path.suffix.lower() in VIDEO_EXTS:
        report["warnings"].append("Container extension suggests video, but no video stream was found")
    if not report["audio"]:
        report["warnings"].append("No audio stream found")
    if args.silence:
        report["silence"] = _silence_detect(path, args.silence_noise, args.silence_duration, args.timeout)
    if args.black and report["video"]:
        report["black_frames"] = _black_detect(path, args.black_threshold, args.black_duration, args.timeout)
    if args.thumbnails and report["video"]:
        out_dir = temp_output_dir(args.thumbnails_dir)
        report["thumbnails"] = _thumbnails(path, out_dir, args.thumbnails, args.timeout)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect audio/video files with ffprobe and optional QA detectors.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", help="Write JSON report here (default: stdout)")
    parser.add_argument("--silence", action="store_true", help="Run silence detector")
    parser.add_argument("--silence-noise", default="-35dB")
    parser.add_argument("--silence-duration", type=float, default=0.5)
    parser.add_argument("--black", action="store_true", help="Run black-frame detector for videos")
    parser.add_argument("--black-threshold", type=float, default=0.10)
    parser.add_argument("--black-duration", type=float, default=0.5)
    parser.add_argument("--thumbnails", type=int, default=0, help="Generate N thumbnails for visual review")
    parser.add_argument("--thumbnails-dir", default="/workspace/temp/av_thumbnails")
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    try:
        write_json_report(inspect(args), args.output)
    except Exception as exc:
        fail_main(exc)


if __name__ == "__main__":
    main()
