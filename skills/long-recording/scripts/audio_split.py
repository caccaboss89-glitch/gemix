#!/usr/bin/env python3
"""Prepare a long recording for transcription by read_file.

read_file transcribes audio up to a fixed length and size, and refuses a video
past a much shorter one. Anything longer has to arrive as a series of audio
parts, each comfortably inside those limits. This does that in one call: probe
the source, decide whether it needs splitting at all, and — when it does —
produce every part in a single ffmpeg pass, printing the path and start offset
of each so the transcripts can be stitched back into one timeline.

Prints one `PART=` line per piece and exits 0; on failure prints REASON= on
stderr and exits non-zero.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# read_file transcribes audio up to 600 s and 25 MB. The chunk length stays
# under the first with room for rounding, and 32 kbps mono keeps a full chunk
# near 2 MB, so the size limit is never the binding one.
DEFAULT_CHUNK_SECONDS = 570
MAX_PART_BYTES = 25 * 1024 * 1024
PART_BITRATE = "32k"
PART_SAMPLE_RATE = "16000"

DEFAULT_OUT_DIR = "/workspace/audio"
NAMESPACE_ROOTS = ("workspace", "attachments", "skills")
PROBE_TIMEOUT = 60
SPLIT_TIMEOUT = 1800


class SplitError(Exception):
    """Anything that stops the job, with the reason to print."""


def container_path(raw):
    """Resolve a path the model typed into the absolute one inside the sandbox.

    The model writes namespace paths ("workspace/talk.mp4"); ffmpeg wants the
    mount ("/workspace/talk.mp4"). A bare relative path means the workspace,
    the same default the file tools apply.
    """
    text = str(raw).strip().replace("\\", "/")
    if not text:
        raise SplitError("no input path given")
    if text.startswith("file://"):
        text = text[len("file://"):]
    text = text.lstrip("/")
    first = text.split("/", 1)[0].lower()
    if first in NAMESPACE_ROOTS:
        return "/" + text
    return "/workspace/" + text


def display_path(absolute):
    """The namespace string the model passes to read_file."""
    return str(absolute).replace("\\", "/").lstrip("/")


def timecode(seconds):
    total = int(round(seconds))
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


def parse_offset(text):
    """Accept seconds or HH:MM:SS / MM:SS."""
    if text is None:
        return None
    raw = str(text).strip()
    if not raw:
        return None
    if ":" not in raw:
        try:
            return max(0.0, float(raw))
        except ValueError:
            raise SplitError(f"cannot read the offset {raw!r}")
    parts = raw.split(":")
    if len(parts) > 3:
        raise SplitError(f"cannot read the offset {raw!r}")
    total = 0.0
    for part in parts:
        try:
            total = total * 60 + float(part)
        except ValueError:
            raise SplitError(f"cannot read the offset {raw!r}")
    return max(0.0, total)


def probe(path):
    """Duration in seconds and which kinds of stream the file carries."""
    try:
        run = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT
        )
    except FileNotFoundError:
        raise SplitError("ffprobe is not available")
    except subprocess.TimeoutExpired:
        raise SplitError("ffprobe timed out")
    if run.returncode != 0:
        raise SplitError(f"ffprobe refused the file: {run.stderr.strip().splitlines()[-1:] or ['unreadable']}")

    try:
        data = json.loads(run.stdout or "{}")
    except json.JSONDecodeError:
        raise SplitError("ffprobe returned no usable metadata")

    kinds = {s.get("codec_type") for s in data.get("streams", [])}
    duration = 0.0
    for candidate in (data.get("format", {}).get("duration"),
                      *(s.get("duration") for s in data.get("streams", []))):
        try:
            duration = max(duration, float(candidate))
        except (TypeError, ValueError):
            continue
    if "audio" not in kinds:
        raise SplitError("this file has no audio track, so there is nothing to transcribe")
    if duration <= 0:
        raise SplitError("the file reports no duration")
    return duration, kinds


def split(source, out_dir, chunk_seconds, start_at, stop_at):
    """One ffmpeg pass: mono 32 kbps MP3, cut into fixed-length parts."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("part-*.mp3"):
        stale.unlink()

    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if start_at:
        command += ["-ss", f"{start_at:.3f}"]
    if stop_at:
        command += ["-to", f"{stop_at:.3f}"]
    command += [
        "-i", source,
        "-vn", "-ac", "1", "-ar", PART_SAMPLE_RATE,
        "-c:a", "libmp3lame", "-b:a", PART_BITRATE,
        "-f", "segment", "-segment_time", str(chunk_seconds),
        "-segment_start_number", "1", "-reset_timestamps", "1",
        str(out_dir / "part-%03d.mp3")
    ]
    try:
        run = subprocess.run(command, capture_output=True, text=True, timeout=SPLIT_TIMEOUT)
    except FileNotFoundError:
        raise SplitError("ffmpeg is not available")
    except subprocess.TimeoutExpired:
        raise SplitError("ffmpeg timed out while splitting")
    if run.returncode != 0:
        detail = (run.stderr or "").strip().splitlines()
        raise SplitError(f"ffmpeg failed: {detail[-1] if detail else 'no output'}")

    parts = sorted(out_dir.glob("part-*.mp3"))
    if not parts:
        raise SplitError("ffmpeg produced no parts")
    oversized = [p.name for p in parts if p.stat().st_size > MAX_PART_BYTES]
    if oversized:
        raise SplitError(f"parts came out over the read_file size limit: {', '.join(oversized)}")
    return parts


def main():
    parser = argparse.ArgumentParser(description="Split a long recording into transcribable audio parts.")
    parser.add_argument("input", help="workspace/ or attachments/ path to the audio or video file")
    parser.add_argument("--chunk-seconds", type=int, default=DEFAULT_CHUNK_SECONDS,
                        help=f"length of each part (default {DEFAULT_CHUNK_SECONDS})")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help=f"where the parts go (default {DEFAULT_OUT_DIR})")
    parser.add_argument("--from", dest="start", help="skip everything before this point (seconds or HH:MM:SS)")
    parser.add_argument("--to", dest="stop", help="stop at this point (seconds or HH:MM:SS)")
    args = parser.parse_args()

    source = container_path(args.input)
    if not os.path.isfile(source):
        raise SplitError(f"{display_path(source)} is not a file")
    if args.chunk_seconds < 30:
        raise SplitError("--chunk-seconds below 30 makes more parts than it saves")

    duration, kinds = probe(source)
    start_at = parse_offset(args.start) or 0.0
    stop_at = parse_offset(args.stop)
    if stop_at is not None and stop_at <= start_at:
        raise SplitError("--to must come after --from")
    span = (stop_at if stop_at is not None else duration) - start_at
    if span <= 0:
        raise SplitError("--from is past the end of the recording")

    print("STATUS=ok")
    print(f"SOURCE={display_path(source)}")
    print(f"DURATION={timecode(duration)}")
    print(f"DURATION_S={int(round(duration))}")

    # An audio file already inside both limits needs nothing done to it: the
    # cheapest handling of a short recording is to read the original.
    fits = (
        "video" not in kinds
        and span >= duration - 1
        and duration <= args.chunk_seconds
        and os.path.getsize(source) <= MAX_PART_BYTES
    )
    if fits:
        print("ACTION=read-original")
        print("PARTS=1")
        print(f"PART=1 PATH={display_path(source)} START=00:00:00 START_S=0 SECONDS={int(round(duration))}")
        return

    parts = split(source, Path(container_path(args.out_dir)), args.chunk_seconds, start_at, stop_at)
    print("ACTION=split")
    print(f"PARTS={len(parts)}")
    for index, part in enumerate(parts):
        offset = start_at + index * args.chunk_seconds
        seconds = min(args.chunk_seconds, span - index * args.chunk_seconds)
        print(
            f"PART={index + 1} PATH={display_path(part)} START={timecode(offset)} "
            f"START_S={int(round(offset))} SECONDS={int(round(seconds))}"
        )


if __name__ == "__main__":
    try:
        main()
    except SplitError as err:
        print("STATUS=failed", file=sys.stderr)
        print(f"REASON={err}", file=sys.stderr)
        sys.exit(1)
