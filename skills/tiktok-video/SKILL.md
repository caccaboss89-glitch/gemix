---
name: tiktok-video
description: Watch a public TikTok — one shell call downloads it, one read_file plays it. Use when you need to see what is in a TikTok: a link sent on its own means they want your reaction to the video itself, not a comment on the link.
---

# Watching a TikTok

## Goal

The video in `workspace/tiktok/video.mp4` and in your context, in one round of two tool calls, so the next thing you produce is your answer.

## What the link usually means

A TikTok dropped in a chat or a group with nothing else attached is an invitation to watch it and say something — the same thing a friend does when they hand you their phone. React to what actually happens in the clip: the moment that lands, the thing that is off, the punchline. Do not summarize it back to them like a report, do not describe the URL, and never answer from the caption or the username alone.

When they ask for something specific instead — send me the file, transcribe it, cut it, pull the audio — do that job and skip the reaction.

## The two calls, same round

Emit both in one model turn. The output path is fixed, so `read_file` does not need to wait to learn it, and the shell call is executed before the read either way.

1. `shell`, `timeoutSeconds: 180`:

```
python3 /skills/tiktok-video/scripts/tiktok_fetch.py '<the URL exactly as it was sent>'
```

2. `read_file` on `workspace/tiktok/video.mp4`.

`read_file` gives you the spoken transcript plus frames sampled across the clip: that is you watching it. On-screen text is usually burned into the image, so read the frames, not just the transcript — and a silent clip is normal, not a failure.

## Rules

- Single-quote the URL. Pass it as it was sent, share text and tracking parameters included; the script finds the link inside it and resolves `vm.tiktok.com`, `vt.tiktok.com` and `/t/` short links itself.
- The script prints `STATUS=ok`, the path, and — when TikTok exposes them — the author handle and the caption. Use that as context around the video, never in place of it.
- Two links in one message: give each its own `--out workspace/tiktok/<n>.mp4` and read each one back. Otherwise leave `--out` alone.
- The script writes only the MP4. Do not save the embed page, the state JSON, subtitle files, contact sheets or extracted audio, and do not go looking for the video on other sites or in web search.
- Do not clear the workspace. The script replaces its own output and nothing else.

## When it fails

The script exits non-zero and prints `REASON=` on stderr. Read it before doing anything else.

- No `REASON=` at all: the sandbox stopped the process, the script did not give up, and the shell result says what stopped it. Run it once more; if it dies the same way, tell the user the download will not go through right now rather than blaming the link.
- Private, deleted, login-gated, region-blocked, a LIVE or a photo slideshow: nothing retrieves it. Say so plainly and move on — do not retry, and never pretend you watched it.
- Anything else (a changed embed shape, a yt-dlp error): it already tried both paths. Run it once more only if the reason names a timeout or a transient network error. If it fails again, tell the user TikTok is not serving that one right now, and fix this skill if the reason shows the procedure itself is out of date.
- `read_file` refusing the clip as too long is not a download failure: cut the part you need with `ffmpeg` and read that.

For subtitles, the full post metadata, frame extraction, audio-only jobs and anything else beyond watching, see [REFERENCE.md](skills/tiktok-video/REFERENCE.md).
