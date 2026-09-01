#!/usr/bin/env python3
"""Download one public TikTok video into the sandbox, in a single call.

Resolves a canonical or shortened share URL to a video id, reads TikTok's own
public embed state in memory, downloads the MP4 the state points at, and falls
back to the installed yt-dlp when that state no longer carries a media URL.
Nothing intermediate is written: no HTML, no state JSON (unless --json), no
subtitles, no frames.

Public posts only. It does not work around login, privacy, deletion or region
blocks, and it handles neither LIVE streams nor photo slideshows.

Result on success, on stdout, one `KEY=value` per line:

    STATUS=ok
    PATH=workspace/tiktok/video.mp4
    VIA=embed|yt-dlp
    ID=<numeric id>
    AUTHOR=@handle          (omitted when the state does not carry it)
    CAPTION=<one line>      (omitted when the state does not carry it)
    DURATION=<seconds>      (omitted when ffprobe is unavailable)
    BYTES=<file size>

On failure it prints STATUS=failed and REASON=<why> on stderr and exits 1.
"""

from __future__ import annotations

import argparse
import collections
import html as html_lib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

DEFAULT_OUT = "/workspace/tiktok/video.mp4"
# The namespace the model names paths in, and the one root of it that takes
# writes: `/attachments` and `/skills` are read-only mounts.
NAMESPACE_ROOTS = ("workspace", "attachments", "skills")
WRITABLE_ROOT = "workspace"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
# A share link can bounce through several tiktok.com hops before the canonical
# video URL appears; more than this is a redirect loop, not a share link.
MAX_REDIRECTS = 8
CONNECT_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 60
# Well past any real TikTok, and short enough that a wrong URL fails fast.
MAX_BYTES = 200 * 1024 * 1024


class FetchError(Exception):
    """A reason the video could not be retrieved, phrased for the caller."""


# -- URL and id ---------------------------------------------------------------


def extract_url(raw: str) -> str:
    """The first HTTP(S) URL in the text, so pasted share blurbs work too."""
    match = re.search(r"https?://[^\s<>\"']+", raw)
    if not match:
        raise FetchError("no HTTP(S) URL was found in the supplied text")
    return match.group(0).rstrip(".,;:!?)]}")


def is_tiktok_url(value: str) -> bool:
    parsed = urlsplit(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    return parsed.scheme in ("http", "https") and (
        host == "tiktok.com" or host.endswith(".tiktok.com")
    )


def video_id(value: str) -> str | None:
    # Decode repeatedly: login and share redirects nest the canonical URL.
    decoded = value
    for _ in range(3):
        decoded = unquote(decoded)
    match = re.search(r"/(?:video|v)/(\d{15,25})(?:[./?#]|$)", decoded)
    if not match:
        match = re.search(r"(?:item_id|itemId)=(\d{15,25})(?:[&#]|$)", decoded)
    return match.group(1) if match else None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def resolve_video_id(source_url: str) -> str:
    """Follow a short share link by hand until the canonical id shows up."""
    found = video_id(source_url)
    if found:
        return found

    opener = build_opener(_NoRedirect)
    current = source_url
    for _ in range(MAX_REDIRECTS):
        found = video_id(current)
        if found:
            return found
        if not is_tiktok_url(current):
            raise FetchError("a share redirect left the tiktok.com domain")

        location = None
        body = ""
        try:
            response = opener.open(
                Request(current, headers={"User-Agent": USER_AGENT}), timeout=CONNECT_TIMEOUT
            )
            location = response.headers.get("Location")
            if not location:
                body = response.read(2 * 1024 * 1024).decode("utf-8", "replace")
            response.close()
        except HTTPError as exc:
            if exc.code not in (301, 302, 303, 307, 308):
                raise FetchError(f"the share link answered HTTP {exc.code}") from exc
            location = exc.headers.get("Location")

        if location:
            current = urljoin(current, location)
            continue
        # The hop answered with a page instead of a redirect: the id is in it.
        found = video_id(body)
        if found:
            return found
        break

    raise FetchError("could not derive a TikTok video id from the share URL")


# -- Embed state --------------------------------------------------------------


def _embed_state(vid: str) -> dict:
    embed_url = f"https://www.tiktok.com/embed/v2/{vid}"
    request = Request(
        embed_url,
        headers={"User-Agent": USER_AGENT, "Accept-Language": "it-IT,it;q=0.9,en;q=0.8"},
    )
    try:
        with urlopen(request, timeout=CONNECT_TIMEOUT) as response:
            page = response.read().decode("utf-8", "replace")
    except HTTPError as exc:
        raise FetchError(f"TikTok's embed page answered HTTP {exc.code}") from exc

    match = re.search(
        r"<script[^>]*id=[\"']__FRONTITY_CONNECT_STATE__[\"'][^>]*>(.*?)</script>",
        page,
        re.S | re.I,
    )
    if not match:
        raise FetchError("TikTok's embed page did not expose its state JSON")
    try:
        return json.loads(html_lib.unescape(match.group(1)))
    except ValueError as exc:
        raise FetchError("TikTok's embed state was not valid JSON") from exc


def _media_urls(video: dict) -> list[str]:
    """Playable URLs from a post's `video` object, whichever field carries them."""
    urls = video.get("urls")
    if isinstance(urls, list):
        found = [u for u in urls if isinstance(u, str) and u.startswith("http")]
        if found:
            return found
    for key in ("playAddr", "downloadAddr"):
        value = video.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return [value]
    return []


def find_post(state: object) -> tuple[dict, list[str]]:
    """The first post in the state that carries a playable video, breadth-first.

    Searched by shape rather than by a fixed key path: the embed state has been
    reorganized before, and the post is recognizable by having a `video` object
    with a URL in it wherever it sits.
    """
    pending = collections.deque([state])
    while pending:
        node = pending.popleft()
        if isinstance(node, dict):
            video = node.get("video")
            if isinstance(video, dict):
                urls = _media_urls(video)
                if urls:
                    return node, urls
            pending.extend(node.values())
        elif isinstance(node, list):
            pending.extend(node)
    raise FetchError(
        "the embed state carries no playable video "
        "(private, deleted, region-blocked, a LIVE or a photo slideshow)"
    )


def post_metadata(post: dict) -> dict[str, str]:
    """Author handle and caption, when the post object carries them."""
    meta: dict[str, str] = {}
    author = post.get("authorInfos")
    handle = author.get("uniqueId") if isinstance(author, dict) else None
    if not isinstance(handle, str):
        handle = post.get("authorId") if isinstance(post.get("authorId"), str) else None
    if handle:
        meta["AUTHOR"] = f"@{handle.lstrip('@')}"
    for key in ("text", "desc"):
        caption = post.get(key)
        if isinstance(caption, str) and caption.strip():
            meta["CAPTION"] = re.sub(r"\s+", " ", caption).strip()
            break
    return meta


# -- Download -----------------------------------------------------------------


def download(media_url: str, referer: str, out_file: Path) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    temp_file = out_file.with_name(f".{out_file.name}.part")
    temp_file.unlink(missing_ok=True)
    request = Request(
        media_url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": referer,
            "Accept": "video/av1,video/webm,video/mp4,*/*;q=0.8",
        },
    )
    try:
        written = 0
        with urlopen(request, timeout=DOWNLOAD_TIMEOUT) as response, temp_file.open("wb") as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_BYTES:
                    raise FetchError(f"the media exceeded {MAX_BYTES} bytes")
                output.write(chunk)
        if written < 1024:
            raise FetchError("TikTok returned a file too small to be a valid video")
        temp_file.replace(out_file)
    except HTTPError as exc:
        temp_file.unlink(missing_ok=True)
        raise FetchError(f"the signed media URL answered HTTP {exc.code}") from exc
    except Exception:
        temp_file.unlink(missing_ok=True)
        raise


def download_with_ytdlp(source_url: str, out_file: Path) -> None:
    if not shutil.which("yt-dlp"):
        raise FetchError("yt-dlp is not installed in this container")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.unlink(missing_ok=True)
    run = subprocess.run(
        [
            "yt-dlp",
            "--no-playlist",
            "--no-progress",
            "--no-warnings",
            "--no-part",
            "--socket-timeout", "30",
            "-S", "ext:mp4:m4a",
            "--remux-video", "mp4",
            "-o", str(out_file),
            source_url,
        ],
        text=True,
        capture_output=True,
    )
    if run.returncode != 0:
        detail = (run.stderr or run.stdout or "").strip().splitlines()
        raise FetchError(f"yt-dlp failed: {detail[-1] if detail else 'no output'}")
    if not out_file.exists():
        # A remux can settle on the real container extension instead of the one
        # the template asked for; the file is there, under a sibling name.
        produced = sorted(out_file.parent.glob(f"{out_file.stem}.*"))
        if not produced:
            raise FetchError("yt-dlp reported success but wrote no file")
        produced[0].replace(out_file)


def probe_duration(out_file: Path) -> str | None:
    """Seconds as ffprobe reports them, and proof the container is playable."""
    if not shutil.which("ffprobe"):
        return None
    run = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(out_file),
        ],
        text=True,
        capture_output=True,
    )
    if run.returncode != 0:
        out_file.unlink(missing_ok=True)
        raise FetchError("the downloaded file did not pass ffprobe validation")
    value = run.stdout.strip()
    return value or None


# -- Entry point --------------------------------------------------------------


def display_path(out_file: Path) -> str:
    """The namespace path the file tools use: `workspace/...`, not `/workspace/...`."""
    return str(out_file).replace("\\", "/").lstrip("/")


def writable_container_path(raw: str) -> Path:
    """Resolve `--out` into an absolute sandbox path the video can be written to.

    The model names paths in the namespace ("workspace/tiktok/1.mp4"), which is
    relative until the mount is prepended — and only `/workspace` accepts a
    write, so the other roots are refused with a reason rather than left to
    surface as an OSError with no REASON= line at all.
    """
    text = str(raw).strip().replace("\\", "/").lstrip("/")
    if not text:
        raise FetchError("no output path given")
    first = text.split("/", 1)[0].lower()
    # A first segment the namespace does not know is a path inside the
    # workspace, the same default the file tools apply.
    resolved = "/" + text if first in NAMESPACE_ROOTS else f"/{WRITABLE_ROOT}/{text}"
    if resolved.split("/")[1].lower() != WRITABLE_ROOT:
        raise FetchError(f"{display_path(Path(resolved))} is read-only; the video has to go under {WRITABLE_ROOT}/")
    return Path(resolved)


def main() -> int:
    parser = argparse.ArgumentParser(description="Download one public TikTok video.")
    parser.add_argument("url", help="TikTok share URL, or text containing one")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"destination file (default {DEFAULT_OUT})")
    parser.add_argument(
        "--json",
        action="store_true",
        help="also write the post object beside the video, as <out>.json",
    )
    args = parser.parse_args()

    try:
        out_file = writable_container_path(args.out)
        # Clear the destination before anything else can fail: a stale video
        # left from an earlier link would be read as if it were this one.
        out_file.unlink(missing_ok=True)
        out_file.with_suffix(out_file.suffix + ".json").unlink(missing_ok=True)

        source_url = extract_url(args.url)
        if not is_tiktok_url(source_url):
            raise FetchError("the supplied URL is not on tiktok.com")
        vid = resolve_video_id(source_url)

        result = {"ID": vid}
        try:
            state = _embed_state(vid)
            post, media_urls = find_post(state)
            download(media_urls[0], f"https://www.tiktok.com/embed/v2/{vid}", out_file)
            result["VIA"] = "embed"
            result.update(post_metadata(post))
            if args.json:
                out_file.with_suffix(out_file.suffix + ".json").write_text(
                    json.dumps(post, ensure_ascii=False, indent=2), encoding="utf-8"
                )
        except FetchError as embed_error:
            # The embed path is the fast one, not the only one: a state whose
            # shape changed, or a post it will not serve, still often works
            # through the extractor.
            print(f"NOTE=embed path failed ({embed_error}); trying yt-dlp", file=sys.stderr)
            try:
                download_with_ytdlp(source_url, out_file)
            except FetchError as ytdlp_error:
                # Both are gone. The embed reason describes the post itself,
                # the extractor only ever reports its own trouble, so lead
                # with the one the caller can actually act on.
                raise FetchError(f"{embed_error}; and {ytdlp_error}") from ytdlp_error
            result["VIA"] = "yt-dlp"

        duration = probe_duration(out_file)
        if duration:
            result["DURATION"] = duration
        result["BYTES"] = str(out_file.stat().st_size)
    except FetchError as error:
        print("STATUS=failed", file=sys.stderr)
        print(f"REASON={error}", file=sys.stderr)
        return 1

    print("STATUS=ok")
    print(f"PATH={display_path(out_file)}")
    for key in ("VIA", "ID", "AUTHOR", "CAPTION", "DURATION", "BYTES"):
        if key in result:
            print(f"{key}={result[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
