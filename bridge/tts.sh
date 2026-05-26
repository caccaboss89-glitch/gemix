#!/usr/bin/env bash
# bridge/tts.sh
#
# Wrapper around `hermes -t tts` for xAI TTS generation. Used by
# src/tools/voiceMessage.js because Hermes Agent v0.14's OpenAI-compatible
# proxy does NOT forward `/v1/tts` (404 "path_not_allowed" — the proxy
# whitelists only /chat/completions, /completions, /embeddings, /models,
# /responses).
#
# Hermes itself ships an internal `tts` toolset that calls the
# `text_to_speech` tool. The CLI is the only way to drive it. The wrapper
# follows the same pattern as bridge/imagine.sh: build a single-line
# instruction telling the model to use exactly one tool, save the output
# to an explicit path we own, and reply with that path on stdout.
#
# Usage:
#   bridge/tts.sh "<text>" "<output_path>"
#
# Arguments:
#   text: Plain text to speak (any language; Hermes will auto-detect or use
#         the language implied by the text). Do NOT include vocal effect tags
#         — Hermes inserts them on its own.
#   output_path: Absolute path where the audio file should be saved
#         (e.g. /home/ubuntu/DiscordBots/GemiX/.tempfiles/tts_1234567890_abc123.mp3).
#         The caller (voiceMessage.js) provides this path; the script verifies
#         the file exists on disk before returning.
#
# Output:
#   stdout : the absolute output_path (after the script verifies the file
#            actually exists on disk — the host trusts only this verified
#            path, never anything the model may have hallucinated).
#   stderr : any diagnostic output from hermes (warnings, etc.)
#
# Exit codes:
#   0  success (file exists at output_path)
#   2  bad usage
#   3  hermes -z failed
#   4  hermes -z succeeded but the file was not produced at output_path

set -euo pipefail

TEXT="${1:-}"
OUTPUT_PATH="${2:-}"

if [[ -z "$TEXT" || -z "$OUTPUT_PATH" ]]; then
  echo "tts.sh: missing text or output_path (usage: tts.sh <text> <output_path>)" >&2
  exit 2
fi

# Make sure the parent dir exists — hermes/text_to_speech may refuse to
# create intermediate directories.
mkdir -p "$(dirname "$OUTPUT_PATH")"

# Instruction handed to hermes. The bridge's contract:
#   1. Use ONLY the text_to_speech tool.
#   2. Speak EXACTLY the user-provided text (no rewrites, no translations,
#      no paraphrasing — preserve the original language and meaning).
#   3. Add expressive vocal tags where natural — Hermes is the one picking
#      tags now; the upstream caller (GemiX) only sends plain text.
#   4. Save to OUR explicit path so we don't have to scrape ~/voice-memos/.
#   5. Reply with one short confirmation line (we don't read it — we check
#      the file directly).
INSTRUCTION="Use ONLY the text_to_speech tool to generate a voice message saying EXACTLY the text below, without paraphrasing, translating, or modifying it in any way. Preserve the original language and meaning. Add expressive vocal tags wherever natural to make the delivery lively and human; do not narrate them, weave them into the text. Available inline tags: [pause] [long-pause] [hum-tune] [laugh] [chuckle] [giggle] [cry] [tsk] [tongue-click] [lip-smack] [breath] [inhale] [exhale] [sigh]. Available wrapping tags: <soft> <whisper> <loud> <build-intensity> <decrease-intensity> <higher-pitch> <lower-pitch> <slow> <fast> <sing-song> <singing> <laugh-speak> <emphasis>. Save the audio to this exact absolute path: ${OUTPUT_PATH}. Reply with one short line, no markdown."

# Single line: hermes -z treats newlines as prompt terminators.
FULL_PROMPT="${INSTRUCTION} | Text to speak (between triple quotes): \"\"\"${TEXT}\"\"\""

TMP_OUT="$(mktemp)"
TMP_ERR="$(mktemp)"
cleanup() { rm -f "$TMP_OUT" "$TMP_ERR"; }
trap cleanup EXIT

# --yolo : auto-approve the tool call (no TTY prompt)
# --ignore-rules : strip AGENTS.md / SOUL.md / preloaded skills from the prompt
# -t tts : restrict the toolset to text_to_speech
# -z : one-shot non-interactive mode (same as imagine.sh)
if ! hermes --yolo --ignore-rules -t tts -z "$FULL_PROMPT" >"$TMP_OUT" 2>"$TMP_ERR"; then
  echo "tts.sh: hermes -z exited non-zero" >&2
  echo "--- hermes stdout ---" >&2
  cat "$TMP_OUT" >&2
  echo "--- hermes stderr ---" >&2
  cat "$TMP_ERR" >&2
  exit 3
fi

# Forward hermes stderr (kept for logs even on success).
if [[ -s "$TMP_ERR" ]]; then
  cat "$TMP_ERR" >&2
fi

# Verify the file actually landed where we asked. If not, the host treats
# this as a soft failure and falls back to Google Translate TTS — never
# trust whatever path the model echoed back without a filesystem check.
if [[ ! -f "$OUTPUT_PATH" ]]; then
  echo "tts.sh: hermes did not produce an audio file at ${OUTPUT_PATH}" >&2
  echo "--- hermes stdout ---" >&2
  cat "$TMP_OUT" >&2
  exit 4
fi

# stdout: only the verified path, single line.
printf '%s\n' "$OUTPUT_PATH"
