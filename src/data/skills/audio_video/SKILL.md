---
name: audio_video
description: Audio/video editing only (.mp4, .mov, .mkv, .webm, .mp3, .wav, .m4a). Trim, cut, concatenate, normalize audio, resize/crop/rotate, watermark, add existing subtitles, slideshow, QA. NOT for generating brand-new media from text or creating subtitles from audio.
---

# Audio/Video Editing Skill Guide

> [!IMPORTANT]
> **MANDATORY RULE**: Use ONLY the CLI flags explicitly documented for each script in this guide. **DO NOT invent flags**. If a flag is not listed here, it is NOT supported.

**Audio/video files are NOT auto-parsed by the system**. To "see" duration, streams, resolution, codecs, audio presence, black/silent segments, you MUST run `av_inspect.py` first — `read_file` on binary media will return garbage.

This skill is for **editing existing media**, NOT creation from text prompts. It can assemble existing images/audio/video into an edited deliverable, but it does not generate novel footage or speech.

The sandbox already includes **ffmpeg**, **ffprobe**, `pydub`, `librosa`, `moviepy`, and `imageio-ffmpeg`. These scripts use `ffmpeg/ffprobe` as the robust primary backend.

> **Goal**: produce delivery-grade media edits in the minimum number of rounds — inspect in Phase 1 when needed, write JSON specs in Phase 2 when needed, run edit + QA in Phase 3. Iterate only if QA reports real issues.

---

## Script Reference

| Script | Purpose | Use when |
| :--- | :--- | :--- |
| `av_inspect.py` | Structured inspection via ffprobe; optional silence/black-frame detection and thumbnails | ✅ **Run first** for complex edits; optional for simple trim from start/end |
| `av_trim.py` | Trim ranges, remove segments, concatenate files after normalization | Cutting intros/outros, ads, mistakes, joining clips |
| `av_audio.py` | Extract audio, normalize loudness, fades, mix voice over background music | Podcast/social audio cleanup and replacement tracks |
| `av_video.py` | Resize, crop, rotate, speed change, watermark, thumbnails | Visual transforms and preview frames |
| `av_compose.py` | Replace audio, add subtitles, image slideshow, split-screen grid | Multi-input composition |
| `av_qa.py` | Final QA: stream presence, duration, dimensions, bitrate, silence, black frames, size | ✅ **MANDATORY** after editing before delivery |

### Execution Strategy

- **Reading existing file**: `av_inspect.py` in `execution_phase: "before_all"` so the JSON report lands before edit logic. Then run edits in Phase 3.
- **Simple trim from start/end**: use `av_trim.py trim` with `--remove-start` and/or `--remove-end` directly without inspection. Then run `av_qa.py`.
- **Complex edits (crop/resize/precise trim)**: inspect (Phase 1) + edit script (Phase 3) + `av_qa.py` (Phase 3 after the edit) in the same round when parameters are already clear.
- **JSON-driven composition**: `write_file` the slideshow spec in Phase 2 + `av_compose.py slideshow` + `av_qa.py` in Phase 3.
- **Preview thumbnails**: generate thumbnails with `av_inspect.py --thumbnails` or `av_video.py thumbnails`; read the generated JPGs in the **next** round only if visual review is genuinely needed.
- **Conversion-only**: use the relevant script or direct `ffmpeg` only for trivial remux/transcode; still run `av_qa.py` for final deliverables.

**Audio/Video-Specific Rules**:
- **Binary format**: NEVER `read_file` media files (`.mp4`, `.mov`, `.mkv`, `.webm`, `.mp3`, `.wav`, `.m4a`). Use `av_inspect.py`.
- **Absolute paths**: Strict enforcement of `/workspace/` or `/readonly/` prefixes. Final media goes in `/workspace/output/`; inspections, thumbnails, segment pieces, JSON specs go in `/workspace/temp/`.
- **No `cat << EOF`**: Never build JSON specs via bash heredoc; always `write_file`.
- **NO code_execution on spec.json**: NEVER use `code_execution` to modify JSON specs. Always rewrite the complete JSON using `write_file`.
- **Scripts vs Tools**: All utilities are SCRIPTS, called via `bash`. DO NOT try to use them as tool names.
- **No Concatenation**: NEVER combine multiple audio/video scripts in a single `bash` command using `&&`/`;`/`|`. Emit separate tool calls in the same round, using execution phases for ordering.
- **Readonly writes**: NEVER write back to `/readonly/...`. To edit a user-provided media file in place-like workflows, write the edited copy to `/workspace/temp/` or `/workspace/output/`.
- **Auto-delivery**: The final `.mp4`, `.mp3`, `.wav`, `.m4a`, etc. MUST end up in `/workspace/output/`. Anything in `/workspace/temp/` will NOT be auto-delivered.
- **Consistent output filename**: Use one clear final filename (e.g. `/workspace/output/final_video.mp4`). If rebuilding after QA, overwrite the same file; do not create many confusing variants.
- **Copy mode caveat**: `--mode copy` is fast but cuts only on keyframes and may be imprecise. Use default `--mode encode` for exact edits and professional output.
- **Quality defaults**: For video, default CRF 18 + `yuv420p` + `+faststart` is high quality and web-compatible. For audio, default AAC 192k is suitable for web/social delivery.
- **Social compatibility**: Prefer `.mp4` with H.264/AAC for videos unless user asks otherwise. Avoid exotic codecs for final delivery.
- **Aspect ratio**: For resize, prefer `--fit contain` to avoid cropping important content; use `--fit cover` only when the target format requires full-frame vertical/square output.
- **Silence/black detection**: Detectors are heuristic. Do not delete all detected silence/black automatically unless the user explicitly requested it or the segment is clearly intro/outro/dead air.
- **Existing style wins**: When editing a user-provided video, preserve resolution, frame rate, audio presence, branding, and pacing unless user asks to change them.
- **yt-dlp**: If downloading source media is needed, use bash CLI directly as allowed by the sandbox briefing; max 1080p; no proxy args. Then edit the downloaded file with this skill.

---

## Output Quality Requirements

Every edited media deliverable MUST satisfy:

- **Playable final file**: `av_qa.py` reports valid positive duration and required streams.
- **Correct stream intent**: videos that should include sound have audio; audio-only deliverables have no accidental video stream.
- **No accidental huge files**: set a reasonable `--max-size-mb` in QA for chat delivery when the user expects a small file.
- **Web-compatible video**: H.264 + AAC in `.mp4`, even dimensions, `yuv420p`, faststart.
- **No distorted visuals**: use contain/cover/crop deliberately; never stretch people/logos unless user explicitly asks.
- **Clean audio**: normalize spoken content when appropriate; avoid music overpowering voice (`music_gain` default is deliberately low).
- **No unintended black/silent tails**: run `av_qa.py --check-black --check-silence` for edited videos where intros/outros were cut.
- **Professional pacing**: cuts should be frame/time accurate; use encode mode for final editorial cuts.

---

## `av_inspect.py` — Inspect Existing Media

> Run this BEFORE editing or analysing any pre-existing audio/video file. Output is JSON with streams, codecs, duration, resolution, bitrate, rotation, and optional detector results.

```bash
# Phase 1 (before_all) — inspect before deciding the edit plan
python /readonly/skills/audio_video/scripts/av_inspect.py \
  --input /readonly/history/source.mp4 \
  --output /workspace/temp/av_inspection.json
# Optional flags: --silence, --silence-noise -35dB, --silence-duration 0.5,
#                 --black, --black-threshold 0.10, --black-duration 0.5,
#                 --thumbnails N, --thumbnails-dir /workspace/temp/thumbs,
#                 --timeout 300
```

**Inspection JSON schema:**

```json
{
  "file": "/readonly/history/source.mp4",
  "duration": 42.3,
  "video": [{"codec": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "30/1", "rotation": 0}],
  "audio": [{"codec": "aac", "sample_rate": 48000, "channels": 2}],
  "warnings": [],
  "silence": [{"start": 0.0, "end": 1.2, "duration": 1.2}],
  "black_frames": [{"start": 40.1, "end": 42.3, "duration": 2.2}],
  "thumbnails": ["/workspace/temp/thumbs/thumb_001.jpg"]
}
```

---

## `av_trim.py` — Trim, Remove Segments, Concatenate

### Exact trim

```bash
# Phase 3 (after_all) — inspect first for precise timing, or skip for simple start/end cuts
python /readonly/skills/audio_video/scripts/av_trim.py trim \
  --input /readonly/history/source.mp4 \
  --start 00:00:03.500 \
  --end 00:00:27.000 \
  --output /workspace/output/final_video.mp4
# Optional flags: --duration 12.5, --mode encode|copy (default encode),
#                 --audio-only, --crf 18, --preset medium, --audio-bitrate 192k,
#                 --timeout 300
```

**Trim from start or end without inspection:**
```bash
# Remove first 3 seconds and last 5 seconds (no inspection needed)
python /readonly/skills/audio_video/scripts/av_trim.py trim \
  --input /readonly/history/source.mp4 \
  --remove-start 00:00:03 \
  --remove-end 00:00:05 \
  --output /workspace/output/final_video.mp4
# --remove-start removes N seconds from the start
# --remove-end removes N seconds from the end
# Error if video is too short for both cuts
```

### Remove multiple bad segments

```bash
python /readonly/skills/audio_video/scripts/av_trim.py remove-segments \
  --input /readonly/history/interview.mp4 \
  --segments 00:00:00-00:00:02.2,00:01:13.5-00:01:18 \
  --output /workspace/output/interview_clean.mp4
# Optional flags: --workdir /workspace/temp/av_trim, --mode encode|copy,
#                 --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

### Concatenate clips

```bash
python /readonly/skills/audio_video/scripts/av_trim.py concat \
  --inputs /readonly/history/clip1.mp4 /readonly/history/clip2.mp4 /readonly/history/clip3.mp4 \
  --output /workspace/output/combined.mp4
# Optional flags: --workdir /workspace/temp/av_concat, --audio-only, --fps N,
#                 --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

**Do not guess generated piece names** after `remove-segments` or `concat`; read stdout or inspect `/workspace/temp/av_trim` only if needed.

---

## `av_audio.py` — Audio Cleanup and Mixing

### Extract normalized audio

```bash
python /readonly/skills/audio_video/scripts/av_audio.py extract \
  --input /readonly/history/video.mp4 \
  --output /workspace/output/audio_clean.m4a \
  --normalize
# Optional flags: --fade-in 0.5, --fade-out 1.0, --duration <seconds>,
#                 --bitrate 192k, --sample-rate 48000, --timeout 300
```

### Normalize existing audio

```bash
python /readonly/skills/audio_video/scripts/av_audio.py normalize \
  --input /readonly/history/podcast.wav \
  --output /workspace/output/podcast_normalized.mp3
# Optional flags: --bitrate 192k, --sample-rate 48000, --timeout 300
```

### Mix voice over background music

```bash
python /readonly/skills/audio_video/scripts/av_audio.py mix \
  --voice /readonly/history/voice.wav \
  --music /readonly/history/music.mp3 \
  --output /workspace/output/voice_music_mix.m4a \
  --music-gain 0.18
# Optional flags: --duration first|shortest|longest, --bitrate 192k, --timeout 300
```

### Apply fades

```bash
python /readonly/skills/audio_video/scripts/av_audio.py fade \
  --input /readonly/history/audio.mp3 \
  --output /workspace/output/audio_faded.mp3 \
  --fade-in 1.0 \
  --fade-out 2.0 \
  --duration 60 \
  --normalize
# Optional flags: --bitrate 192k, --sample-rate 48000, --timeout 300
```

> `--duration` is required for `--fade-out` because the fade-out start must be computed from the known final duration. Get it from `av_inspect.py`.

---

## `av_video.py` — Video Transforms

### Resize for platform formats

```bash
# 16:9 web/video delivery
python /readonly/skills/audio_video/scripts/av_video.py resize \
  --input /readonly/history/source.mp4 \
  --resolution 1920x1080 \
  --fit contain \
  --output /workspace/output/video_1080p.mp4
# Optional flags: --fit contain|cover|stretch, --pad-color black,
#                 --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

Common targets:

| Use | Resolution | Fit |
| :--- | :--- | :--- |
| YouTube/web landscape | `1920x1080` | `contain` |
| Instagram/TikTok/Reels | `1080x1920` | `cover` if vertical crop is acceptable, otherwise `contain` |
| Square social post | `1080x1080` | `cover` for full frame, `contain` to preserve all content |
| Lightweight preview | `1280x720` | `contain` |

### Crop

```bash
python /readonly/skills/audio_video/scripts/av_video.py crop \
  --input /readonly/history/source.mp4 \
  --x 320 --y 0 --width 1080 --height 1080 \
  --output /workspace/output/cropped_square.mp4
# Optional flags: --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

### Rotate

```bash
python /readonly/skills/audio_video/scripts/av_video.py rotate \
  --input /readonly/history/sideways.mp4 \
  --angle 90 \
  --output /workspace/output/rotated.mp4
# angle: 90, 180, 270, -90, -180, -270
# Optional flags: --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

### Speed change

```bash
python /readonly/skills/audio_video/scripts/av_video.py speed \
  --input /readonly/history/source.mp4 \
  --factor 1.25 \
  --output /workspace/output/faster.mp4
# factor > 1 speeds up; factor < 1 slows down
# Optional flags: --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

### Watermark

```bash
python /readonly/skills/audio_video/scripts/av_video.py watermark \
  --input /readonly/history/source.mp4 \
  --watermark /readonly/permanent/logo.png \
  --position bottom-right \
  --width 220 \
  --opacity 0.85 \
  --output /workspace/output/watermarked.mp4
# Optional flags: --position top-left|top-right|bottom-left|bottom-right|center,
#                 --width 220, --opacity 0.85, --crf 18, --preset medium,
#                 --audio-bitrate 192k, --timeout 300
```

### Thumbnails for visual review

```bash
python /readonly/skills/audio_video/scripts/av_video.py thumbnails \
  --input /workspace/output/final_video.mp4 \
  --output-dir /workspace/temp/final_thumbs \
  --count 6
# Optional flags: --width 640, --pattern thumb_%03d.jpg, --timeout 300
```

---

## `av_compose.py` — Multi-input Composition

### Replace a video's audio track

```bash
python /readonly/skills/audio_video/scripts/av_compose.py replace-audio \
  --video /readonly/history/muted_video.mp4 \
  --audio /workspace/output/voice_music_mix.m4a \
  --shortest \
  --copy-video \
  --output /workspace/output/final_with_audio.mp4
# Optional flags: --shortest, --copy-video, --crf 18, --preset medium,
#                 --audio-bitrate 192k, --timeout 300
```

### Add subtitles

```bash
# Soft subtitles (toggleable, fastest)
python /readonly/skills/audio_video/scripts/av_compose.py add-subtitles \
  --video /readonly/history/source.mp4 \
  --subtitles /workspace/temp/captions.srt \
  --output /workspace/output/subtitled.mp4

# Burned-in subtitles (visible everywhere)
python /readonly/skills/audio_video/scripts/av_compose.py add-subtitles \
  --video /readonly/history/source.mp4 \
  --subtitles /workspace/temp/captions.srt \
  --burn-in \
  --output /workspace/output/subtitled_burned.mp4
# Optional flags: --burn-in, --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

### Image slideshow from JSON spec

Pair `write_file` Phase 2 with the `bash` call Phase 3.

```json
{
  "music": "/readonly/history/background.mp3",
  "slides": [
    {"image": "/readonly/history/photo1.jpg", "duration": 3.5},
    {"image": "/readonly/history/photo2.jpg", "duration": 4.0},
    {"image": "/readonly/history/photo3.jpg", "duration": 3.5}
  ]
}
```

```bash
python /readonly/skills/audio_video/scripts/av_compose.py slideshow \
  --spec /workspace/temp/slideshow.json \
  --resolution 1920x1080 \
  --output /workspace/output/slideshow.mp4
# Optional flags: --workdir /workspace/temp/av_slideshow, --default-duration 4.0,
#                 --background black, --fps 30, --music <path>, --crf 18,
#                 --preset medium, --audio-bitrate 192k, --timeout 300
```

### Split-screen video grid

```bash
python /readonly/skills/audio_video/scripts/av_compose.py grid \
  --inputs /readonly/history/a.mp4 /readonly/history/b.mp4 /readonly/history/c.mp4 /readonly/history/d.mp4 \
  --columns 2 \
  --cell-width 960 \
  --cell-height 540 \
  --output /workspace/output/grid.mp4
# Optional flags: --columns N, --cell-width 960, --cell-height 540,
#                 --crf 18, --preset medium, --audio-bitrate 192k, --timeout 300
```

---

## `av_qa.py` — Final QA

Run after every edit before delivery.

```bash
python /readonly/skills/audio_video/scripts/av_qa.py \
  --input /workspace/output/final_video.mp4 \
  --require-video \
  --require-audio \
  --min-width 720 \
  --min-height 720 \
  --max-size-mb 95 \
  --check-silence \
  --check-black \
  --output /workspace/temp/final_video_qa.json
# Optional flags: --max-bitrate-kbps N, --silence-noise -35dB,
#                 --silence-duration 2.0, --black-threshold 0.10,
#                 --black-duration 1.0, --timeout 300
```

**QA JSON schema:**

```json
{
  "file": "/workspace/output/final_video.mp4",
  "duration": 31.2,
  "size_bytes": 8400000,
  "video_streams": 1,
  "audio_streams": 1,
  "issue_count": 0,
  "issues": {}
}
```

If `issue_count > 0`, inspect the issue type before rebuilding. Some silence is intentional in music videos or dramatic pauses; do not over-fix without user intent.

---

## Parallel Phase Recipes

### Recipe A — Cut intro/outro and QA in one round

Emit these tool calls in the same round:

```bash
# Phase 1 before_all
python /readonly/skills/audio_video/scripts/av_inspect.py \
  --input /readonly/history/source.mp4 \
  --output /workspace/temp/source_inspect.json \
  --black \
  --silence
```

```bash
# Phase 3 after_all
python /readonly/skills/audio_video/scripts/av_trim.py trim \
  --input /readonly/history/source.mp4 \
  --start 00:00:02 \
  --end 00:00:31 \
  --output /workspace/output/final_video.mp4
```

```bash
# Phase 3 after_all, emitted AFTER av_trim.py
python /readonly/skills/audio_video/scripts/av_qa.py \
  --input /workspace/output/final_video.mp4 \
  --require-video \
  --require-audio \
  --check-black \
  --check-silence \
  --output /workspace/temp/final_video_qa.json
```

### Recipe B — Slideshow with spec + QA in one round

- Phase 2: `write_file` `/workspace/temp/slideshow.json`
- Phase 3: `av_compose.py slideshow`
- Phase 3: `av_qa.py` after slideshow

Do NOT use `code_execution` to write or modify the JSON.

### Recipe C — Voice/music mix then replace video audio

Emit separate Phase 3 bash calls in order:

```bash
python /readonly/skills/audio_video/scripts/av_audio.py mix \
  --voice /readonly/history/voice.wav \
  --music /readonly/history/music.mp3 \
  --music-gain 0.15 \
  --output /workspace/temp/mix.m4a
```

```bash
python /readonly/skills/audio_video/scripts/av_compose.py replace-audio \
  --video /readonly/history/video.mp4 \
  --audio /workspace/temp/mix.m4a \
  --shortest \
  --copy-video \
  --output /workspace/output/final_video.mp4
```

```bash
python /readonly/skills/audio_video/scripts/av_qa.py \
  --input /workspace/output/final_video.mp4 \
  --require-video \
  --require-audio \
  --output /workspace/temp/final_video_qa.json
```

---

## Troubleshooting & Common Fails

### 1. `read_file` on `.mp4`/`.mp3` returns garbage
Use `av_inspect.py`. Binary media is not human-readable.

### 2. Trim is off by a few frames
You used `--mode copy` or a direct ffmpeg stream copy. Re-run with default `--mode encode` for exact cuts.

### 3. Final video has no audio
Run `av_inspect.py` on the source first. If source has no audio, do not use `--require-audio` unless you add a track. For `replace-audio`, verify the replacement file has an audio stream.

### 4. Final video is huge
Use `.mp4` output, keep default CRF 18 for high quality, or raise to CRF 20-23 for smaller files if user prioritizes size. Run `av_qa.py --max-size-mb`.

### 5. Background music overpowers voice
Use `av_audio.py mix --music-gain 0.10` to `0.20`; default `0.18` is intentionally conservative.
