#!/usr/bin/env python3
import argparse
from pathlib import Path
from typing import List

from av_utils import fail_main, ffmpeg_overwrite_base, input_path, loudnorm_filter, output_path, quality_audio_args, run_cmd


def _af_chain(parts: List[str]) -> str:
    return ",".join([p for p in parts if p])


def extract(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out = output_path(args.output)
    filters = []
    if args.normalize:
        filters.append(loudnorm_filter())
    if args.fade_in:
        filters.append(f"afade=t=in:st=0:d={args.fade_in}")
    if args.fade_out and args.duration:
        if args.duration <= args.fade_out:
            raise ValueError(f"Duration ({args.duration}s) must be greater than fade_out ({args.fade_out}s)")
        filters.append(f"afade=t=out:st={args.duration - args.fade_out}:d={args.fade_out}")
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-vn"]
    if filters:
        cmd += ["-af", _af_chain(filters)]
    if out.suffix.lower() == ".wav":
        cmd += ["-c:a", "pcm_s16le", "-ar", str(args.sample_rate)]
    else:
        cmd += quality_audio_args(args.bitrate)
    cmd += [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Audio extracted -> {out}")


def normalize(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out = output_path(args.output)
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-af", loudnorm_filter()]
    if out.suffix.lower() == ".wav":
        cmd += ["-c:a", "pcm_s16le", "-ar", str(args.sample_rate)]
    else:
        cmd += quality_audio_args(args.bitrate)
    cmd += [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Audio normalized -> {out}")


def mix(args: argparse.Namespace) -> None:
    voice = input_path(args.voice)
    music = input_path(args.music)
    out = output_path(args.output)
    voice_gain = float(args.voice_gain)
    music_gain = float(args.music_gain)
    fc = (
        f"[0:a]volume={voice_gain},{loudnorm_filter()}[v];"
        f"[1:a]volume={music_gain},afade=t=in:st=0:d={args.music_fade_in}[m];"
        f"[v][m]amix=inputs=2:duration={args.duration}:dropout_transition=2,{loudnorm_filter()}[a]"
    )
    cmd = ffmpeg_overwrite_base() + ["-i", str(voice), "-stream_loop", "-1", "-i", str(music), "-filter_complex", fc, "-map", "[a]"]
    cmd += quality_audio_args(args.bitrate) + [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Audio mixed -> {out}")


def fade(args: argparse.Namespace) -> None:
    src = input_path(args.input)
    out = output_path(args.output)
    filters = []
    if args.fade_in > 0:
        filters.append(f"afade=t=in:st=0:d={args.fade_in}")
    if args.fade_out > 0:
        if args.duration is None:
            raise ValueError("--duration is required when using --fade-out")
        if args.duration <= args.fade_out:
            raise ValueError(f"Duration ({args.duration}s) must be greater than fade_out ({args.fade_out}s)")
        filters.append(f"afade=t=out:st={args.duration - args.fade_out}:d={args.fade_out}")
    if args.normalize:
        filters.append(loudnorm_filter())
    if not filters:
        raise ValueError("No fade/normalize operation requested")
    cmd = ffmpeg_overwrite_base() + ["-i", str(src), "-af", _af_chain(filters)]
    if out.suffix.lower() == ".wav":
        cmd += ["-c:a", "pcm_s16le", "-ar", str(args.sample_rate)]
    else:
        cmd += quality_audio_args(args.bitrate)
    cmd += [str(out)]
    run_cmd(cmd, timeout=args.timeout)
    print(f"Audio faded -> {out}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Audio extraction, normalization, fades, and voice/music mixing.")
    sub = parser.add_subparsers(dest="action", required=True)

    p_extract = sub.add_parser("extract", help="Extract audio from audio/video")
    p_extract.add_argument("--input", required=True)
    p_extract.add_argument("--output", required=True)
    p_extract.add_argument("--normalize", action="store_true")
    p_extract.add_argument("--fade-in", type=float, default=0.0)
    p_extract.add_argument("--fade-out", type=float, default=0.0)
    p_extract.add_argument("--duration", type=float)
    p_extract.add_argument("--bitrate", default="192k")
    p_extract.add_argument("--sample-rate", type=int, default=48000)
    p_extract.add_argument("--timeout", type=int, default=120)

    p_norm = sub.add_parser("normalize", help="Normalize loudness to podcast/web target")
    p_norm.add_argument("--input", required=True)
    p_norm.add_argument("--output", required=True)
    p_norm.add_argument("--bitrate", default="192k")
    p_norm.add_argument("--sample-rate", type=int, default=48000)
    p_norm.add_argument("--timeout", type=int, default=120)

    p_mix = sub.add_parser("mix", help="Mix voice over looped background music")
    p_mix.add_argument("--voice", required=True)
    p_mix.add_argument("--music", required=True)
    p_mix.add_argument("--output", required=True)
    p_mix.add_argument("--voice-gain", type=float, default=1.0)
    p_mix.add_argument("--music-gain", type=float, default=0.18)
    p_mix.add_argument("--music-fade-in", type=float, default=1.5)
    p_mix.add_argument("--duration", default="first", choices=["first", "shortest", "longest"])
    p_mix.add_argument("--bitrate", default="192k")
    p_mix.add_argument("--timeout", type=int, default=300)

    p_fade = sub.add_parser("fade", help="Apply audio fades and optional normalization")
    p_fade.add_argument("--input", required=True)
    p_fade.add_argument("--output", required=True)
    p_fade.add_argument("--fade-in", type=float, default=0.0)
    p_fade.add_argument("--fade-out", type=float, default=0.0)
    p_fade.add_argument("--duration", type=float)
    p_fade.add_argument("--normalize", action="store_true")
    p_fade.add_argument("--bitrate", default="192k")
    p_fade.add_argument("--sample-rate", type=int, default=48000)
    p_fade.add_argument("--timeout", type=int, default=120)

    args = parser.parse_args()
    try:
        if args.action == "extract":
            extract(args)
        elif args.action == "normalize":
            normalize(args)
        elif args.action == "mix":
            mix(args)
        elif args.action == "fade":
            fade(args)
    except Exception as exc:
        fail_main(exc)


if __name__ == "__main__":
    main()
