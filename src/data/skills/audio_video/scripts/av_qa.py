#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from av_utils import fail_main, ffprobe_json, input_path, run_cmd, write_json_report


def _detect_silence(path: Path, noise: str, duration: float, timeout: int) -> List[Dict[str, Any]]:
    proc = run_cmd([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-af", f"silencedetect=noise={noise}:d={duration}", "-f", "null", "-"
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
                pass
    return events


def _detect_black(path: Path, threshold: float, duration: float, timeout: int) -> List[Dict[str, Any]]:
    proc = run_cmd([
        "ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
        "-vf", f"blackdetect=d={duration}:pix_th={threshold}", "-an", "-f", "null", "-"
    ], timeout=timeout)
    events: List[Dict[str, Any]] = []
    for line in proc.stderr.splitlines():
        if "black_start:" in line:
            try:
                import re
                start_match = re.search(r"black_start:\s*([\d.]+)", line)
                end_match = re.search(r"black_end:\s*([\d.]+)", line)
                dur_match = re.search(r"black_duration:\s*([\d.]+)", line)
                if start_match and end_match and dur_match:
                    events.append({
                        "start": float(start_match.group(1)),
                        "end": float(end_match.group(1)),
                        "duration": float(dur_match.group(1))
                    })
            except Exception:
                pass
    return events


def qa(args: argparse.Namespace) -> Dict[str, Any]:
    path = input_path(args.input)
    probe = ffprobe_json(path)
    fmt = probe.get("format", {})
    streams = probe.get("streams", [])
    duration = float(fmt.get("duration", 0) or 0)
    size = int(fmt.get("size", 0) or 0)
    bit_rate = int(fmt.get("bit_rate", 0) or 0)
    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    audio_streams = [s for s in streams if s.get("codec_type") == "audio"]
    issues: Dict[str, List[Dict[str, Any]]] = {
        "missing_stream": [],
        "bad_duration": [],
        "oversized": [],
        "low_resolution": [],
        "odd_dimensions": [],
        "huge_bitrate": [],
        "silence": [],
        "black_frames": [],
    }
    if args.require_video and not video_streams:
        issues["missing_stream"].append({"stream": "video"})
    if args.require_audio and not audio_streams:
        issues["missing_stream"].append({"stream": "audio"})
    if duration <= 0:
        issues["bad_duration"].append({"duration": duration})
    if args.max_size_mb and size > args.max_size_mb * 1024 * 1024:
        issues["oversized"].append({"size_mb": round(size / 1024 / 1024, 2), "limit_mb": args.max_size_mb})
    if args.max_bitrate_kbps and bit_rate > args.max_bitrate_kbps * 1000:
        issues["huge_bitrate"].append({"bitrate_kbps": round(bit_rate / 1000), "limit_kbps": args.max_bitrate_kbps})
    for s in video_streams:
        w = int(s.get("width", 0) or 0)
        h = int(s.get("height", 0) or 0)
        if args.min_width and w < args.min_width:
            issues["low_resolution"].append({"width": w, "height": h, "min_width": args.min_width})
        if args.min_height and h < args.min_height:
            issues["low_resolution"].append({"width": w, "height": h, "min_height": args.min_height})
        if w % 2 or h % 2:
            issues["odd_dimensions"].append({"width": w, "height": h})
    if args.check_silence and audio_streams:
        silences = _detect_silence(path, args.silence_noise, args.silence_duration, args.timeout)
        issues["silence"] = [s for s in silences if s.get("duration", 0) >= args.silence_duration]
    if args.check_black and video_streams:
        black = _detect_black(path, args.black_threshold, args.black_duration, args.timeout)
        issues["black_frames"] = [b for b in black if b.get("duration", 0) >= args.black_duration]
    filtered = {k: v for k, v in issues.items() if v}
    return {
        "file": str(path),
        "duration": duration,
        "size_bytes": size,
        "bit_rate": bit_rate,
        "video_streams": len(video_streams),
        "audio_streams": len(audio_streams),
        "issue_count": sum(len(v) for v in filtered.values()),
        "issues": filtered,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Static QA checks for final audio/video deliverables.")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", help="Write JSON report here (default: stdout)")
    parser.add_argument("--require-video", action="store_true")
    parser.add_argument("--require-audio", action="store_true")
    parser.add_argument("--min-width", type=int)
    parser.add_argument("--min-height", type=int)
    parser.add_argument("--max-size-mb", type=float)
    parser.add_argument("--max-bitrate-kbps", type=int)
    parser.add_argument("--check-silence", action="store_true")
    parser.add_argument("--silence-noise", default="-35dB", help="Noise threshold (e.g. -35dB)")
    parser.add_argument("--silence-duration", type=float, default=2.0)
    parser.add_argument("--check-black", action="store_true")
    parser.add_argument("--black-threshold", type=float, default=0.10)
    parser.add_argument("--black-duration", type=float, default=1.0)
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    try:
        write_json_report(qa(args), args.output)
    except Exception as exc:
        fail_main(exc)


if __name__ == "__main__":
    main()
