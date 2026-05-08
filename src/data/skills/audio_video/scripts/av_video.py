#!/usr/bin/env python3
import argparse
from pathlib import Path
from typing import List

from av_utils import fail_main, ffmpeg_overwrite_base, input_path, output_path, parse_resolution, quality_audio_args, quality_video_args, run_cmd, temp_output_dir


def resize(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out = output_path(args.output)
    w, h = parse_resolution(args.resolution)
    if args.fit == "contain":
        vf = f"scale=w={w}:h={h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={args.pad_color},setsar=1"
    elif args.fit == "cover":
        vf = f"scale=w={w}:h={h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1"
    else:
        vf = f"scale={w}:{h},setsar=1"
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-vf", vf]
    cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Video resized -> {out}")


def crop(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out = output_path(args.output)
    vf = f"crop={args.width}:{args.height}:{args.x}:{args.y},scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1"
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-vf", vf]
    cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Video cropped -> {out}")


def rotate(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out = output_path(args.output)
    filters = {
        90: "transpose=1",
        180: "transpose=1,transpose=1",
        270: "transpose=2",
        -90: "transpose=2",
        -180: "transpose=1,transpose=1",
        -270: "transpose=3",
    }
    vf = filters[args.angle] + ",setsar=1"
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-vf", vf]
    cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Video rotated -> {out}")


def speed(args: argparse.Namespace) -> None:
    from av_utils import has_audio
    src = input_path(args.input)
    out = output_path(args.output)
    factor = float(args.factor)
    if factor <= 0:
        raise ValueError("--factor must be > 0")
    video_filter = f"setpts={1.0 / factor:.8f}*PTS"
    has_audio_track = has_audio(src)
    if has_audio_track:
        audio_filters: List[str] = []
        remaining = factor
        while remaining > 2.0:
            audio_filters.append("atempo=2.0")
            remaining /= 2.0
        while remaining < 0.5:
            audio_filters.append("atempo=0.5")
            remaining /= 0.5
        audio_filters.append(f"atempo={remaining:.6f}")
        cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-filter_complex", f"[0:v]{video_filter}[v];[0:a]{','.join(audio_filters)}[a]", "-map", "[v]", "-map", "[a]"]
    else:
        cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-vf", video_filter]
    cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Speed changed -> {out}")


def watermark(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    mark = input_path(args.watermark)
    out = output_path(args.output)
    overlay = {
        "top-left": "20:20",
        "top-right": "main_w-overlay_w-20:20",
        "bottom-left": "20:main_h-overlay_h-20",
        "bottom-right": "main_w-overlay_w-20:main_h-overlay_h-20",
        "center": "(main_w-overlay_w)/2:(main_h-overlay_h)/2",
    }[args.position]
    fc = f"[1:v]scale={args.width}:-1,format=rgba,colorchannelmixer=aa={args.opacity}[wm];[0:v][wm]overlay={overlay}:format=auto[v]"
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-i", str(mark), "-filter_complex", fc, "-map", "[v]", "-map", "0:a?"]
    cmd += quality_video_args(args.crf, args.preset) + quality_audio_args(args.audio_bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Watermark applied -> {out}")


def thumbnails(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out_dir = temp_output_dir(args.output_dir)
    pattern = out_dir / args.pattern
    vf = f"fps={args.count}/max(duration,1),scale='min({args.width},iw)':-2"
    run_cmd(ffmpeg_overwrite_base() + ["-i", str(src), "-vf", vf, "-frames:v", str(args.count), "-q:v", "3", str(pattern)], timeout=args.timeout)
    print(f"Thumbnails written -> {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Common video transforms: resize, crop, rotate, speed, watermark, thumbnails.")
    sub = parser.add_subparsers(dest="action", required=True)

    def encode_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--crf", type=int, default=18)
        p.add_argument("--preset", default="medium", choices=["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])
        p.add_argument("--audio-bitrate", default="192k")
        p.add_argument("--timeout", type=int, default=120)

    p_resize = sub.add_parser("resize", help="Resize/pad/crop to target resolution")
    p_resize.add_argument("--input", required=True)
    p_resize.add_argument("--output", required=True)
    p_resize.add_argument("--resolution", required=True, help="WIDTHxHEIGHT")
    p_resize.add_argument("--fit", choices=["contain", "cover", "stretch"], default="contain")
    p_resize.add_argument("--pad-color", default="black")
    encode_common(p_resize)

    p_crop = sub.add_parser("crop", help="Crop rectangular region")
    p_crop.add_argument("--input", required=True)
    p_crop.add_argument("--output", required=True)
    p_crop.add_argument("--x", type=int, required=True)
    p_crop.add_argument("--y", type=int, required=True)
    p_crop.add_argument("--width", type=int, required=True)
    p_crop.add_argument("--height", type=int, required=True)
    encode_common(p_crop)

    p_rotate = sub.add_parser("rotate", help="Rotate video pixels")
    p_rotate.add_argument("--input", required=True)
    p_rotate.add_argument("--output", required=True)
    p_rotate.add_argument("--angle", type=int, choices=[90, 180, 270, -90, -180, -270], required=True)
    encode_common(p_rotate)

    p_speed = sub.add_parser("speed", help="Change audio/video speed")
    p_speed.add_argument("--input", required=True)
    p_speed.add_argument("--output", required=True)
    p_speed.add_argument("--factor", type=float, required=True)
    encode_common(p_speed)

    p_watermark = sub.add_parser("watermark", help="Overlay transparent image watermark")
    p_watermark.add_argument("--input", required=True)
    p_watermark.add_argument("--watermark", required=True)
    p_watermark.add_argument("--output", required=True)
    p_watermark.add_argument("--position", choices=["top-left", "top-right", "bottom-left", "bottom-right", "center"], default="bottom-right")
    p_watermark.add_argument("--width", type=int, default=220)
    p_watermark.add_argument("--opacity", type=float, default=0.85)
    encode_common(p_watermark)

    p_thumbs = sub.add_parser("thumbnails", help="Create representative JPG thumbnails")
    p_thumbs.add_argument("--input", required=True)
    p_thumbs.add_argument("--output-dir", required=True)
    p_thumbs.add_argument("--count", type=int, default=6)
    p_thumbs.add_argument("--width", type=int, default=640)
    p_thumbs.add_argument("--pattern", default="thumb_%03d.jpg")
    p_thumbs.add_argument("--timeout", type=int, default=120)

    args = parser.parse_args()
    try:
        if args.action == "resize":
            resize(args)
        elif args.action == "crop":
            crop(args)
        elif args.action == "rotate":
            rotate(args)
        elif args.action == "speed":
            speed(args)
        elif args.action == "watermark":
            watermark(args)
        elif args.action == "thumbnails":
            thumbnails(args)
    except Exception as exc:
        fail_main(exc)


if __name__ == "__main__":
    main()
