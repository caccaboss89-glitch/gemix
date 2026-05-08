#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from typing import Any, Dict, List

from av_utils import fail_main, ffmpeg_overwrite_base, format_seconds, input_path, output_path, parse_time, quality_audio_args, quality_video_args, run_cmd, safe_concat_file, temp_output_dir


def replace_audio(args: argparse.Namespace) -> None:
    video = input_path(args.video)
    audio = input_path(args.audio)
    out = output_path(args.output)
    cmd = ffmpeg_overwrite_base() + ["-i", str(video), "-i", str(audio), "-map", "0:v:0", "-map", "1:a:0"]
    if args.shortest:
        cmd += ["-shortest"]
    if args.copy_video:
        cmd += ["-c:v", "copy"]
    else:
        cmd += quality_video_args(args.crf, args.preset)
    cmd += quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Audio replaced -> {out}")


def add_subtitles(args: argparse.Namespace) -> None:
    video = input_path(args.video)
    subs = input_path(args.subtitles)
    out = output_path(args.output)
    if args.burn_in:
        sub_path = str(subs).replace("\\", "\\\\").replace("'", "'\\''")
        cmd = ffmpeg_overwrite_base() + ["-i", str(video), "-vf", f"subtitles='{sub_path}'"]
        cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    else:
        cmd = ffmpeg_overwrite_base() + ["-i", str(video), "-i", str(subs), "-map", "0", "-map", "1:0", "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Subtitles added -> {out}")


def slideshow(args: argparse.Namespace) -> None:
    spec_path = input_path(args.spec)
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    slides = spec.get("slides") or []
    if not slides:
        raise ValueError("spec.slides must be a non-empty array")
    out = output_path(args.output)
    work = temp_output_dir(args.workdir)
    clips: List[Path] = []
    for idx, slide in enumerate(slides, start=1):
        image = input_path(slide["image"])
        duration = float(slide.get("duration", args.default_duration))
        if duration <= 0:
            raise ValueError("Slide duration must be > 0")
        clip = work / f"slide_{idx:03d}.mp4"
        vf = f"scale={args.resolution}:force_original_aspect_ratio=decrease,pad={args.resolution}:(ow-iw)/2:(oh-ih)/2:color={args.background},setsar=1,format=yuv420p"
        cmd = ffmpeg_overwrite_base() + ["-loop", "1", "-t", format_seconds(duration), "-i", str(image), "-vf", vf, "-r", str(args.fps)]
        cmd += quality_video_args(args.crf, args.preset) + ["-an", str(clip)]
        run_cmd(cmd, timeout=args.timeout)
        clips.append(clip)
    list_path = work / "slides.txt"
    safe_concat_file(clips, list_path)
    video_no_audio = work / "slideshow_no_audio.mp4"
    run_cmd(ffmpeg_overwrite_base() + ["-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(video_no_audio)], timeout=args.timeout)
    music = spec.get("music") or args.music
    if music:
        music_path = input_path(music)
        run_cmd(ffmpeg_overwrite_base() + ["-i", str(video_no_audio), "-stream_loop", "-1", "-i", str(music_path), "-map", "0:v", "-map", "1:a", "-c:v", "copy"] + quality_audio_args(args.audio_bitrate) + [str(out)], timeout=args.timeout)
    else:
        run_cmd(ffmpeg_overwrite_base() + ["-i", str(video_no_audio), "-c", "copy", str(out)], timeout=args.timeout)
    print(f"Slideshow created -> {out}")


def grid(args: argparse.Namespace) -> None:
    inputs = [input_path(p) for p in args.inputs]
    if len(inputs) < 2:
        raise ValueError("At least two inputs are required")
    out = output_path(args.output)
    cols = args.columns
    rows = (len(inputs) + cols - 1) // cols
    cmd = ffmpeg_overwrite_base()
    for p in inputs:
        cmd += ["-i", str(p)]
    scale_parts = []
    labels = []
    cell_w = args.cell_width
    cell_h = args.cell_height
    for i in range(len(inputs)):
        label = f"v{i}"
        labels.append(f"[{label}]")
        scale_parts.append(f"[{i}:v]scale={cell_w}:{cell_h}:force_original_aspect_ratio=decrease,pad={cell_w}:{cell_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{label}]")
    layout = "|".join(f"{(i % cols) * cell_w}_{(i // cols) * cell_h}" for i in range(len(inputs)))
    fc = ";".join(scale_parts) + ";" + "".join(labels) + f"xstack=inputs={len(inputs)}:layout={layout}:fill=black[v]"
    cmd += ["-filter_complex", fc, "-map", "[v]", "-map", "0:a?"]
    cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Video grid created -> {out}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Compose audio/video: replace audio, subtitles, slideshows, split-screen grids.")
    sub = parser.add_subparsers(dest="action", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--crf", type=int, default=18)
        p.add_argument("--preset", default="medium", choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
        p.add_argument("--audio-bitrate", default="192k")
        p.add_argument("--timeout", type=int, default=120)

    p_replace = sub.add_parser("replace-audio", help="Replace a video's audio track")
    p_replace.add_argument("--video", required=True)
    p_replace.add_argument("--audio", required=True)
    p_replace.add_argument("--output", required=True)
    p_replace.add_argument("--shortest", action="store_true")
    p_replace.add_argument("--copy-video", action="store_true")
    common(p_replace)

    p_sub = sub.add_parser("add-subtitles", help="Add soft or burned-in subtitles")
    p_sub.add_argument("--video", required=True)
    p_sub.add_argument("--subtitles", required=True)
    p_sub.add_argument("--output", required=True)
    p_sub.add_argument("--burn-in", action="store_true")
    common(p_sub)

    p_slide = sub.add_parser("slideshow", help="Build video slideshow from JSON spec")
    p_slide.add_argument("--spec", required=True)
    p_slide.add_argument("--output", required=True)
    p_slide.add_argument("--workdir", default="/workspace/temp/av_slideshow")
    p_slide.add_argument("--default-duration", type=float, default=4.0)
    p_slide.add_argument("--resolution", default="1920x1080")
    p_slide.add_argument("--background", default="black")
    p_slide.add_argument("--fps", type=int, default=30)
    p_slide.add_argument("--music")
    common(p_slide)

    p_grid = sub.add_parser("grid", help="Create split-screen grid from videos")
    p_grid.add_argument("--inputs", nargs="+", required=True)
    p_grid.add_argument("--output", required=True)
    p_grid.add_argument("--columns", type=int, default=2)
    p_grid.add_argument("--cell-width", type=int, default=960)
    p_grid.add_argument("--cell-height", type=int, default=540)
    common(p_grid)

    args = parser.parse_args()
    try:
        if args.action == "replace-audio":
            replace_audio(args)
        elif args.action == "add-subtitles":
            add_subtitles(args)
        elif args.action == "slideshow":
            slideshow(args)
        elif args.action == "grid":
            grid(args)
    except Exception as exc:
        fail_main(exc)


if __name__ == "__main__":
    main()
