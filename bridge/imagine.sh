#!/usr/bin/env bash
# bridge/imagine.sh
#
# Wrapper around `hermes -z` (one-shot mode) for Grok Imagine image/video
# generation. Used by src/tools/imagineGenerator.js because Hermes v0.14
# does not expose Imagine on any REST endpoint of the OpenAI-compatible
# proxy (neither /chat/completions, /responses, nor /images/generations).
#
# Usage:
#   bridge/imagine.sh image "<prompt>" [aspect_ratio]
#   bridge/imagine.sh video "<prompt>" [aspect_ratio] [duration_s] [resolution]
#
# Output:
#   stdout : exactly one line — the URL of the generated media
#   stderr : any diagnostic output from hermes (warnings, etc.)
#
# Exit codes:
#   0  success (URL printed)
#   2  bad usage
#   3  hermes -z failed
#   4  hermes -z succeeded but produced no parseable URL

set -euo pipefail

KIND="${1:-}"
PROMPT="${2:-}"
ASPECT="${3:-}"
DURATION="${4:-10}"
RESOLUTION="${5:-720p}"

if [[ -z "$KIND" || -z "$PROMPT" ]]; then
  echo "imagine.sh: missing kind or prompt (usage: imagine.sh image|video <prompt> [aspect] [duration] [resolution])" >&2
  exit 2
fi

# Build the natural-language instruction appended to the user prompt. We tell
# hermes to use exactly one tool and to reply with ONLY the URL — that's how
# hermes -z reliably emits a single-line stdout we can parse.
case "$KIND" in
  image)
    TOOLSET="image_gen"
    INSTRUCTION="Use ONLY the image_generate tool to generate this image. Reply with EXACTLY ONE LINE containing only the URL of the generated image, with no markdown, no explanation, no extra text."
    if [[ -n "$ASPECT" ]]; then
      INSTRUCTION="${INSTRUCTION} Aspect ratio: ${ASPECT}."
    fi
    ;;
  video)
    TOOLSET="video_gen"
    INSTRUCTION="Use ONLY the video_generate tool to generate this video. Duration: ${DURATION} seconds. Resolution: ${RESOLUTION}. Aspect ratio: ${ASPECT:-16:9}. Reply with EXACTLY ONE LINE containing only the URL of the generated video, with no markdown, no explanation, no extra text."
    ;;
  *)
    echo "imagine.sh: unknown kind '${KIND}' (must be 'image' or 'video')" >&2
    exit 2
    ;;
esac

# Single line: no newlines in the prompt — hermes -z treats newlines as
# prompt terminators and only processes the first line.
FULL_PROMPT="${PROMPT} | ${INSTRUCTION}"

# Run hermes in one-shot mode, restricted to the relevant toolset and with
# rule injection disabled so AGENTS.md / memory / preloaded skills don't
# pollute the prompt. --yolo bypasses any approval prompt for the tool call.
# NOTE: -z must come LAST before the prompt argument, or hermes misparses it.
# NOTE: FULL_PROMPT must be a single line — hermes treats newlines as prompt
# terminators and only processes the first line.
TMP_OUT="$(mktemp)"
TMP_ERR="$(mktemp)"
cleanup() { rm -f "$TMP_OUT" "$TMP_ERR"; }
trap cleanup EXIT

if ! hermes --yolo --ignore-rules -t "$TOOLSET" -z "$FULL_PROMPT" >"$TMP_OUT" 2>"$TMP_ERR"; then
  echo "imagine.sh: hermes -z exited non-zero" >&2
  echo "--- hermes stdout ---" >&2
  cat "$TMP_OUT" >&2
  echo "--- hermes stderr ---" >&2
  cat "$TMP_ERR" >&2
  exit 3
fi

# Strip all whitespace (newlines, tabs, CR) before extracting the URL.
# Sometimes hermes wraps the URL across multiple lines, which breaks
# line-based grep matching.
URL_FLAT="$(tr -d '\r\n\t ' < "$TMP_OUT")"
URL="$(echo "$URL_FLAT" | grep -oE 'https://[^"<>]+' | head -n 1 || true)"

if [[ -z "$URL" ]]; then
  echo "imagine.sh: hermes returned no parseable URL" >&2
  echo "--- hermes stdout ---" >&2
  cat "$TMP_OUT" >&2
  echo "--- hermes stderr ---" >&2
  cat "$TMP_ERR" >&2
  exit 4
fi

# Forward hermes stderr to our stderr (kept for logs even on success).
if [[ -s "$TMP_ERR" ]]; then
  cat "$TMP_ERR" >&2
fi

# stdout: only the URL, single line.
printf '%s\n' "$URL"
