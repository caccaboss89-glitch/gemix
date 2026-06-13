---
name: ffmpeg
description: Process video, audio, or images already in /workspace/ with ffmpeg/ffprobe. Not for downloading from the web or for merely previewing a file (read_file).
---

# FFmpeg Media Processing Guide

A guide for processing media (video, audio, images) with `ffmpeg` and `ffprobe`
inside the build sandbox. Media lives in `/workspace/` (read-write); this skill's
files are read-only under `/skills/ffmpeg/`.

## Companion files

- `references/recipes.md` — extended command cookbook: convert to web MP4, remux,
  faststart, fit-into-canvas/padding, crop, image-sequence → video, mix/replace/
  extract/remove audio, change volume, GIF, soft & burn-in subtitles, mixed-codec
  concat, frame-rate, speed up/down, text & image overlays, rotate, loudness
  normalize, contact sheet/storyboard, slideshow, social-media crops, and more.
  Read it with `read_file /skills/ffmpeg/references/recipes.md` when the core
  recipes below don't cover the task, or for complex `filter_complex`, multi-input,
  or advanced stream-mapping work.

## Sandbox notes (read first)

- **Each `bash` call is a fresh shell.** Variables, `cd`, and `trap` do **not**
  carry over between calls. Run a multi-line recipe as a **single** `bash` command,
  defining `INPUT`/`OUTPUT` (or using literal paths) inside that same command.
- **Absolute paths only**: `/workspace/...` for the media you read and write,
  `/skills/ffmpeg/...` for this guide. Quote every path.
- **ffmpeg reads local files only.** Do not pass web URLs to `-i`. To pull a video
  off the web (YouTube, X, Instagram, TikTok, Facebook), that is `yt-dlp`'s job —
  it downloads into `/workspace/`, then you process the local file here.
- **bash timeout: default 30s, max 120s.** Re-encoding long or high-resolution
  video can exceed this. Raise `timeout_ms` (up to 120000) for heavy encodes. If it
  still won't finish in time, cut the work: stream-copy when possible (`-c copy`), a
  faster `-preset`, lower resolution or higher CRF, or process a shorter range. Add
  `-threads 4` when re-encoding so a single job doesn't hog the host CPU.

## Inspect with ffprobe, understand with read_file

- **`ffprobe` is the source of truth for technical properties** — codec, duration,
  dimensions, frame rate, bitrate, stream layout. Probe before any non-trivial
  command and plan from the JSON, never from numbers you eyeballed.
- **`read_file` works on the media types this skill produces** (video, audio,
  images): use it to *understand* content — what's on screen, whether the audio is
  right — and for final QA. But never retype exact technical values you saw in a
  player view; get those from `ffprobe`.

## Safety policy

### No-overwrite default

Use `-n` unless the user explicitly asks to overwrite (then `-y`).

```bash
ffmpeg -n -i "$INPUT" [output options] "$OUTPUT"
```

### Temp-file workflow

Write to a temp file with the target extension, verify it, then rename — all in one
bash call:

```bash
TMP_OUTPUT="${OUTPUT%.*}.tmp.${OUTPUT##*.}"
ffmpeg -n -i "$INPUT" [output options] "$TMP_OUTPUT" &&
ffprobe -v error "$TMP_OUTPUT" &&
mv "$TMP_OUTPUT" "$OUTPUT"
```

### Other rules

- Quote all file paths.
- Use only local `/workspace/` paths with `-i`; never a user-supplied URL.
- Never delete the input file unless the user explicitly asks.
- After generating output, verify with `ffprobe` (and, when content matters,
  `read_file` the result).
- Clean up any temp files/dirs after a successful operation.

## Inspect first

Always probe unknown media before complex operations:

```bash
# Human-readable
ffprobe -hide_banner -i "$INPUT"

# Machine-readable JSON
ffprobe -v error -show_format -show_streams -of json "$INPUT"

# Quick queries
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$INPUT"   # duration
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$INPUT"  # resolution
ffprobe -v error -show_entries stream=index,codec_type,codec_name -of table "$INPUT"             # codecs
```

## Decision tree: copy vs re-encode

### Use `-c copy` when

- Changing container only (e.g. `.mkv` → `.mp4`)
- Removing or extracting a stream
- Approximate keyframe-aligned trim
- Avoiding quality loss (and to stay fast / under the bash timeout)

```bash
ffmpeg -n -i "$INPUT" -c copy "$OUTPUT"
```

### Re-encode when

- Resizing, cropping, padding, rotating
- Applying any `-vf` or `-af` filter
- Changing codec, frame rate, or pixel format
- Frame-accurate trim required
- Web/browser compatibility required

### Audio codec decision

| Goal | Audio option |
|------|-------------|
| Preserve source audio exactly | `-c:a copy` (may not fit every container) |
| Web-compatible MP4 | `-c:a aac -b:a 128k` (always safe) |
| Audio for transcription | `-vn -acodec pcm_s16le -ar 16000 -ac 1` |

For a web-compatible MP4, prefer `-c:a aac` over `-c:a copy` — copied audio may keep
a codec the browser cannot play.

## Web-compatible MP4 defaults

```bash
ffmpeg -n -i "$INPUT" \
  -c:v libx264 -crf 23 -preset medium -threads 4 \
  -c:a aac -b:a 128k \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUTPUT"
```

| Profile | Codec | CRF | Preset | Audio | Notes |
|---------|-------|-----|--------|-------|-------|
| General (default) | libx264 | 23 | medium | aac 128k | Best compatibility |
| High quality | libx264 | 18 | slow | aac 192k | Archival (slow — watch the timeout) |
| Smaller file | libx264 | 28 | medium | aac 96k | |
| Minimum size | libx264 | 32 | slow | aac 64k | |
| Modern smaller MP4 | libx265 | 24 | medium | aac 128k | Add `-vtag hvc1`; less compatible |
| WebM/VP9 | libvpx-vp9 | 15 | n/a | libopus | Add `-b:v 0`; slow encode |

When the user does not specify a codec, default to H.264 (libx264). Use H.265/VP9
only when asked for smaller files or when the user names those codecs.

## Core recipes

### 1. Inspect media

```bash
ffprobe -hide_banner -i "$INPUT"
```

### 2. Combine / merge / join / stitch videos end-to-end

Use this when the user says "combine", "merge", "join", "stitch", "put end to end",
"make one long video", "append", or "chain" videos — all mean sequential
concatenation (clips played one after another). For side-by-side, overlay, grid, or
picture-in-picture, see `references/recipes.md`.

**Same codec (fast, no re-encode).** The concat demuxer's list uses single-quoted
paths, which breaks on filenames containing single quotes; symlink inputs into a
temp dir with safe names (no file copies). Run the whole block as one bash command:

```bash
INPUT_FILES=("/workspace/video1.mp4" "/workspace/video2.mp4" "/workspace/video3.mp4")
OUTPUT="/workspace/combined.mp4"

_tmpd="$(mktemp -d)"
trap 'rm -rf "$_tmpd"' EXIT

i=0
for f in "${INPUT_FILES[@]}"; do
  safe="$_tmpd/clip_$(printf '%03d' $i).${f##*.}"
  ln -s "$(cd "$(dirname "$f")" && pwd)/$(basename "$f")" "$safe"
  printf "file '%s'\n" "$safe" >> "$_tmpd/concat_list.txt"
  i=$((i+1))
done

ffmpeg -n -f concat -safe 0 -i "$_tmpd/concat_list.txt" -c copy "$OUTPUT"
```

**Mixed codecs (re-encodes).** All inputs must have audio; if any lacks it, add a
silent track first (see `references/recipes.md` → "Handling Missing Audio Streams").
Adjust the `-i` count and `concat=n=N` to match the real number of inputs:

```bash
# Example with 3 inputs — adjust n=, -i count, and stream labels for the real count
ffmpeg -n \
  -i "/workspace/v1.mp4" \
  -i "/workspace/v2.mp4" \
  -i "/workspace/v3.mp4" \
  -filter_complex "[0:v:0][0:a:0][1:v:0][1:a:0][2:v:0][2:a:0]concat=n=3:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" \
  -c:v libx264 -crf 23 -preset medium -threads 4 -c:a aac \
  "/workspace/combined.mp4"
```

For video-only concat and more variants, see `references/recipes.md` →
"Concatenate (Mixed Codecs)".

### 3. Trim

Fast (keyframe-aligned, not frame-accurate):

```bash
ffmpeg -n -ss "00:01:00" -i "$INPUT" -t "00:00:10" -c copy "$OUTPUT"
```

Accurate (re-encodes):

```bash
ffmpeg -n -i "$INPUT" \
  -ss "00:01:00" -t "00:00:10" \
  -c:v libx264 -c:a aac -pix_fmt yuv420p \
  "$OUTPUT"
```

`-t` is a duration from the seek point; use it when the user gives a clip length.
Use input-side `-ss` + `-to` when the user gives absolute source timestamps.

### 4. Fade in / fade out

```bash
# Video + audio fade, 2s in and 2s out of a 30s clip (probe duration first:
# fade-out start = duration - fade_duration)
ffmpeg -n -i "$INPUT" \
  -vf "fade=t=in:st=0:d=2,fade=t=out:st=28:d=2" \
  -af "afade=t=in:st=0:d=2,afade=t=out:st=28:d=2" \
  -c:v libx264 -crf 23 -preset medium -c:a aac \
  "$OUTPUT"
```

For video-only or audio-only fades, drop the matching filter and stream-copy the
other stream. See `references/recipes.md`.

### 5. Resize

```bash
# By width (auto height; -2 keeps dimensions even)
ffmpeg -n -i "$INPUT" -vf "scale=1280:-2" \
  -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k "$OUTPUT"

# By height
ffmpeg -n -i "$INPUT" -vf "scale=-2:720" \
  -c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k "$OUTPUT"
```

If the output aspect ratio looks wrong (non-square pixels) after any scale/pad/crop,
append `setsar=1` to the filter chain.

### 6. Extract frames / single frame / thumbnail

```bash
# One frame per second into a directory
mkdir -p /workspace/frames
ffmpeg -n -i "$INPUT" -vf "fps=1" /workspace/frames/frame_%06d.jpg

# Single frame at a timestamp (thumbnail)
ffmpeg -n -ss "00:00:01.500" -i "$INPUT" -frames:v 1 -q:v 2 "$OUTPUT"
```

For contact sheet / storyboard, slideshow, GIF, and overlay recipes, see
`references/recipes.md`.

## Images in video (overlays, logos, slideshows)

Several recipes add an image (logo/watermark overlay) or build a video from images
(slideshow, image sequence). The images you can use come from:

1. Files GemiX staged in `/workspace/` — user uploads, and images/videos/charts
   generated by GemiX-Main and passed in as attachments.
2. PNGs you render yourself in the sandbox (e.g. a matplotlib chart, then overlay
   or sequence it).
3. Images from `web_search`: save URLs with `download_file` into `/workspace/`.

`generate_image` / `generate_video` do **not** exist inside build. **Use images
proactively** when they improve the result: if a logo, title card, or background
would make the video clearer or more polished and the task didn't supply one, run
`web_search` for images (then `download_file`) or render it yourself, then composite it.

## Output requirements

- Any text you burn into the video (`drawtext`, subtitles) goes in the **user's
  language**, **without emoji** unless the user asked — ffmpeg's default fonts render
  emoji (and many symbols) as empty/black boxes. For user-supplied text use
  `drawtext=textfile=...` to avoid quote/colon escaping issues.
- When editing existing media, **match its properties** (resolution, frame rate,
  codec family, audio layout) instead of imposing new ones, unless the task is
  explicitly to change them.

## Common failure modes

| Error | Fix |
|-------|-----|
| Width/height not divisible by 2 | Add `-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"` |
| Output file already exists | Use a different output path, or `-y` only if overwrite was allowed |
| Codec not supported in container | Re-encode instead of `-c copy` |
| Output has no audio | Probe input; use `-map 0:a:0?` for optional audio |
| Output is huge | Increase CRF (`-crf 28`) or reduce resolution |
| Browser cannot play output | H.264 + AAC + `yuv420p` + `+faststart` |
| MP4 slow to start / not streamable | Add `-movflags +faststart` |
| `moov atom not found` | Input is incomplete/corrupt; re-acquire the source |
| Audio out of sync after speed change | Apply a matching `atempo` to the audio stream |
| Aspect ratio wrong after scale/pad/crop | Append `setsar=1` to the filter chain |
| `drawtext` breaks on special characters | Use `drawtext=textfile=...` for user text |
| Command killed near 30s | Raise `timeout_ms` (≤120000); or stream-copy / faster preset / lower res |
| Variable empty / "command not found: cd" across calls | Shell state doesn't persist — run the whole recipe in one bash call |

## Command construction checklist

1. What is the input path? Probe it with `ffprobe` if unknown.
2. What is the output path and extension?
3. Overwrite allowed? Default `-n`.
4. Container-only change? `-c copy`.
5. Resizing/filtering? Re-encode video.
6. Multiple inputs? Use `-map`.
7. Audio might be absent? Use `0:a:0?`.
8. Web-compatible? H.264 + AAC + `yuv420p` + `+faststart`.
9. Frame-accurate cut? Output-side `-ss`, re-encode.
10. Heavy encode? Raise `timeout_ms`, add `-threads 4`, pick a sane preset/CRF.
11. Verify output with `ffprobe` (and `read_file` it when content matters).

## Agent behavior rules

1. Identify up front: source format, target container/codec, target dimensions/
   duration, and whether the user prioritizes quality, speed, or file size.
2. Inspect with `ffprobe` when media details are unknown.
3. Choose the simplest command that does the job.
4. Treat "combine/merge/join/stitch videos" as sequential concatenation unless the
   user explicitly asks for side-by-side, overlay, grid, or picture-in-picture.
5. Use `-c copy` only when not modifying media content.
6. Re-encode whenever a filter is applied.
7. Quote every path. Keep filter graphs in double quotes; use single quotes inside
   for expressions like `enable='between(t,1,7)'`. Never interpolate untrusted text
   into a filter string — use `textfile=` for user-supplied text.
8. Use `-n` unless overwrite was explicitly requested; write to a new output path.
9. Run each multi-line recipe as one bash command (shell state doesn't persist).
10. Verify the output with `ffprobe`; for content, `read_file` the result.
11. If ffmpeg fails, read the error and adjust — do not retry the same command.
12. For complex `filter_complex`, multi-input, or advanced tasks, read
    `references/recipes.md`.

## References

- FFmpeg documentation: https://ffmpeg.org/ffmpeg.html
- FFprobe documentation: https://ffmpeg.org/ffprobe.html
- FFmpeg filters: https://ffmpeg.org/ffmpeg-filters.html
- H.264 encoding guide: https://trac.ffmpeg.org/wiki/Encode/H.264
