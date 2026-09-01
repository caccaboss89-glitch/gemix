---
name: long-recording
description: Get the full transcript of an audio or a video too long for read_file to take in one go — one shell call splits it, one round of read_file transcribes every part. Use when you need what was said in a recording of more than a few minutes, whether it arrived as audio or as video.
---

# Transcribing a long recording

## Goal

The whole recording transcribed, in three rounds: one to split, one to read every part at once, one to answer.

## What forces this

`read_file` is the only thing here that can turn speech into text — there is no speech-to-text command in the container, so nothing you run in `shell` will transcribe anything. It transcribes audio up to about ten minutes and 25 MB, and refuses a **video** far sooner, at two minutes. So the words of a long video come from its audio track, never from reading the video file.

The script below turns any recording — audio file, voice note, video — into audio parts that fit, in one ffmpeg pass.

This is for what was **said**. If what matters is what is on screen, this is the wrong tool: cut that stretch of video with `ffmpeg` and read the piece, and the parser samples its frames for you.

## The three rounds

**1. `shell`**, `timeoutSeconds: 300`:

```
python3 /skills/long-recording/scripts/audio_split.py 'workspace/<file>'
```

It prints `ACTION=` and one `PART=` line per piece:

```
PART=2 PATH=workspace/audio/part-002.mp3 START=00:09:30 START_S=570 SECONDS=570
```

`ACTION=read-original` means the file already fits: skip the parts and read the path it printed.

**2. `read_file` on every `PATH`, all in the same round.** They run in parallel, so ten parts cost one round, not ten. Do not read them one at a time.

**3. Answer.** Stitch the transcripts in `PART` order.

## Rules

- Each part's transcript restarts at `00:00`. Add that part's `START_S` before quoting any timestamp, or every reference after the first part will be wrong.
- The cut between two parts can clip a word. Read across the join and write the sentence whole; never report a gap there.
- Only a section is wanted ("what does he say around minute 12"): pass `--from 11:30 --to 13:00` and you get one part instead of twelve.
- `--chunk-seconds` and `--out-dir` exist but their defaults are right. Change them only for a reason you can state.
- The script replaces its own output directory each run and touches nothing else. Do not clear the workspace, and do not keep extra copies of the audio.
- A recording with no speech is not a failed transcription: music, ambience and tone come back empty on purpose. Say what the file actually is instead of claiming it failed.

## When it fails

The script exits non-zero and prints `REASON=` on stderr. Read it first.

- `no audio track`: there is nothing to transcribe. Say so — if it is a video, its content is in the picture, so sample frames with `ffmpeg` and read those instead.
- `is not a file`: the path is wrong. Find it with `list_files` rather than guessing a second time.
- An ffmpeg or ffprobe error names a broken or unsupported source. Report that plainly instead of retrying the same call.
- If a part still comes back from `read_file` as too long, the recording is unusually dense: run again with `--chunk-seconds 300`.
