# TikTok: the heavier jobs

Everything here costs extra calls, so it is only worth doing when the user asked for that specific thing. For simply watching a clip and reacting, [SKILL.md](skills/tiktok-video/SKILL.md) is the whole procedure.

Every command below runs in `shell` and assumes the MP4 is already at `workspace/tiktok/video.mp4`.

## Full post metadata

Add `--json` to the fetch and the post object lands beside the video as `workspace/tiktok/video.mp4.json`. It carries whatever the embed state exposes — caption, author, music, counters — and shapes vary, so open it with `read_file` and read what is actually there instead of assuming a field exists.

```
python3 /skills/tiktok-video/scripts/tiktok_fetch.py '<URL>' --json
```

## Subtitles

TikTok's own captions are burned into the picture on most posts. There is no subtitle file to fetch, and asking for one is how a turn gets wasted. Check before you claim otherwise:

```
yt-dlp --list-subs --no-playlist '<URL>'
```

If that lists nothing, the words are either spoken (the `read_file` transcript has them) or drawn on the frames (the sampled frames have them). If it does list a track:

```
yt-dlp --skip-download --write-subs --sub-langs all --no-playlist -o '/workspace/tiktok/subs.%(ext)s' '<URL>'
```

## Audio only

For a transcript of a long clip, or to hand the user the sound:

```
ffmpeg -y -i /workspace/tiktok/video.mp4 -vn -c:a libmp3lame -q:a 4 /workspace/tiktok/audio.mp3
```

`read_file` on the MP4 already returns the transcript, so extract audio only when the user wants the file itself or when the video is too long for the parser.

## Frames

The parser samples frames across the whole clip. Pull your own only when you need a specific instant or a denser sample.

One frame at a timestamp:

```
ffmpeg -y -ss 00:00:07.5 -i /workspace/tiktok/video.mp4 -frames:v 1 /workspace/tiktok/frame-0075.jpg
```

A contact sheet, one frame per second, five per row:

```
ffmpeg -y -i /workspace/tiktok/video.mp4 -vf 'fps=1,scale=320:-1,tile=5x4' /workspace/tiktok/sheet.jpg
```

## Cutting, compressing, converting

Trim a section (stream copy, no re-encode, cuts land on keyframes):

```
ffmpeg -y -ss 00:00:03 -to 00:00:12 -i /workspace/tiktok/video.mp4 -c copy /workspace/tiktok/clip.mp4
```

Shrink one that is too large to send:

```
ffmpeg -y -i /workspace/tiktok/video.mp4 -vf 'scale=-2:720' -c:v libx264 -crf 28 -preset veryfast -c:a aac -b:a 96k /workspace/tiktok/small.mp4
```

Animated GIF from a few seconds:

```
ffmpeg -y -ss 00:00:02 -t 3 -i /workspace/tiktok/video.mp4 -vf 'fps=12,scale=360:-1:flags=lanczos' -loop 0 /workspace/tiktok/clip.gif
```

## Several posts at once

The fetch script handles one post per call. Loop over the links with a distinct `--out` each, in a single `shell` call:

```
for url in '<URL1>' '<URL2>'; do
  python3 /skills/tiktok-video/scripts/tiktok_fetch.py "$url" --out "workspace/tiktok/$(date +%s%N).mp4"
done
```

Then `read_file` each path the script printed. A whole account or hashtag feed is not in scope: the script downloads posts, not listings, and bulk collection is not what these links are sent for.

## When the procedure itself is broken

If `tiktok_fetch.py` fails on posts that are plainly public, TikTok changed something. Diagnose it in one call rather than guessing:

```
python3 /skills/tiktok-video/scripts/tiktok_fetch.py '<URL>'; yt-dlp -v --no-playlist --simulate '<URL>' 2>&1 | tail -30
```

The library is read-only, so the fix is not yours to make: say plainly that TikTok downloads are not working right now, and quote the `REASON=` and the yt-dlp tail so the person who maintains GemiX has the diagnosis. Copying the script into `workspace/` and patching it there fixes nothing beyond this chat, so do not.
