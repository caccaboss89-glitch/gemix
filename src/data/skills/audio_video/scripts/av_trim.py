#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

from av_utils import fail_main, ffmpeg_overwrite_base, format_seconds, input_path, media_duration, output_path, parse_time, quality_audio_args, quality_video_args, run_cmd, safe_concat_file, temp_output_dir


def _encode_args(args: argparse.Namespace) -> List[str]:
    if args.mode == "copy":
        if args.audio_only:
            return ["-c:v", "copy", "-c:a", "copy", "-avoid_negative_ts", "make_zero"]
        return ["-c", "copy", "-avoid_negative_ts", "make_zero"]
    if args.audio_only:
        return quality_audio_args(args.audio_bitrate)
    return quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate)


def trim(args: argparse.Namespace) -> str:
    src = input_path(args.input)
    out = output_path(args.output)
    cmd = ffmpeg_overwrite_base()
    start = parse_time(args.start) if args.start else None
    end = parse_time(args.end) if args.end else None
    duration = parse_time(args.duration) if args.duration else None
    if end is not None and start is not None:
        duration = max(0.0, end - start)
    if start is not None:
        cmd += ["-ss", format_seconds(start)]
    cmd += ["-i", str(src)]
    if duration is not None:
        if duration <= 0:
            raise ValueError("Trim duration must be > 0")
        cmd += ["-t", format_seconds(duration)]
    if args.audio_only:
        cmd += ["-vn"]
    cmd += _encode_args(args)
    cmd += [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Trim completed -> {out}")
    return str(out)


def remove_segments(args: argparse.Namespace) -> str:
    src = input_path(args.input)
    out = output_path(args.output)
    if not args.segments:
        raise ValueError("--segments is required")
    total = media_duration(src)
    raw_segments = []
    for item in args.segments.split(","):
        if "-" not in item:
            raise ValueError(f"Invalid segment '{item}'. Use START-END")
        a, b = item.split("-", 1)
        start, end = parse_time(a), parse_time(b)
        if end <= start:
            raise ValueError(f"Invalid segment '{item}': end must be after start")
        raw_segments.append((max(0.0, start), min(total, end)))
    raw_segments.sort()
    keep = []
    cursor = 0.0
    for start, end in raw_segments:
        if start > cursor:
            keep.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < total:
        keep.append((cursor, total))
    if not keep:
        raise ValueError("All media would be removed")
    work = temp_output_dir(args.workdir)
    pieces: List[Path] = []
    for idx, (start, end) in enumerate(keep, start=1):
        piece = work / f"keep_{idx:03d}{out.suffix}"
        cmd = ffmpeg_overwrite_base() + ["-ss", format_seconds(start), "-i", str(src), "-t", format_seconds(end - start)]
        cmd += _encode_args(args) + [str(piece)]
        run_cmd(cmd, timeout=args.timeout)
        pieces.append(piece)
    list_path = work / "concat.txt"
    safe_concat_file(pieces, list_path)
    run_cmd(ffmpeg_overwrite_base() + ["-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(out)], timeout=args.timeout)
    print(f"Segments removed -> {out}")
    return str(out)


def concat(args: argparse.Namespace) -> str:
    inputs = [input_path(p) for p in args.inputs]
    out = output_path(args.output)
    work = temp_output_dir(args.workdir)
    normalized: List[Path] = []
    for idx, src in enumerate(inputs, start=1):
        norm = work / f"concat_norm_{idx:03d}.mp4"
        cmd = ffmpeg_overwrite_base() + ["-i", str(src)]
        if args.audio_only:
            cmd += ["-vn"] + quality_audio_args(args.audio_bitrate)
        else:
            vf = "scale=trunc(iw/2)*2:trunc(ih/2)*2"
            if args.fps:
                vf += f",fps={args.fps}"
            cmd += ["-vf", vf]
            cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate)
        cmd += [str(norm)]
        run_cmd(cmd, timeout=args.timeout)
        normalized.append(norm)
    list_path = work / "concat.txt"
    safe_concat_file(normalized, list_path)
    run_cmd(ffmpeg_overwrite_base() + ["-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(out)], timeout=args.timeout)
    print(f"Concat completed -> {out}")
    return str(out)


def main() -> None:
    parser = argparse.ArgumentParser(description="Trim, remove segments, or concatenate audio/video files.")
    sub = parser.add_subparsers(dest="action", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--output", required=True)
        p.add_argument("--mode", choices=["encode", "copy"], default="encode")
        p.add_argument("--audio-only", action="store_true")
        p.add_argument("--crf", type=int, default=18)
        p.add_argument("--preset", default="medium", choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
        p.add_argument("--audio-bitrate", default="192k")
        p.add_argument("--timeout", type=int, default=120)

    p_trim = sub.add_parser("trim", help="Extract a time range")
    p_trim.add_argument("--input", required=True)
    p_trim.add_argument("--start")
    p_trim.add_argument("--end")
    p_trim.add_argument("--duration")
    common(p_trim)

    p_remove = sub.add_parser("remove-segments", help="Remove one or more START-END ranges")
    p_remove.add_argument("--input", required=True)
    p_remove.add_argument("--segments", required=True, help="Comma-separated ranges, e.g. 00:01-00:03,10-12.5")
    p_remove.add_argument("--workdir", default="/workspace/temp/av_trim")
    common(p_remove)

    p_concat = sub.add_parser("concat", help="Concatenate files after normalization")
    p_concat.add_argument("--inputs", nargs="+", required=True)
    p_concat.add_argument("--workdir", default="/workspace/temp/av_concat")
    p_concat.add_argument("--fps", type=int, help="Target frame rate (default: keep original)")
    common(p_concat)

    args = parser.parse_args()
    try:
        if args.action == "trim":
            trim(args)
        elif args.action == "remove-segments":
            remove_segments(args)
        elif args.action == "concat":
            concat(args)
    except Exception as exc:
        fail_main(exc)


if __name__ == "__main__":
    main()
