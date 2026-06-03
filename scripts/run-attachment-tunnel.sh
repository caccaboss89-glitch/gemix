#!/usr/bin/env bash
# Runs localtunnel for GemiX temp file server (port 9998) and keeps
# src/data/tunnel-public-url.txt in sync with the live "your url is:" line.
#
# PM2 example (from repo root on the VPS):
#   pm2 start scripts/run-attachment-tunnel.sh --name "[GemiX] Tunnel-Allegati" --interpreter bash
#
# Optional fixed subdomain (fails over to a random *.loca.lt if taken):
#   LT_SUBDOMAIN=gemix-attachments pm2 start ...

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL_FILE="${GEMIX_TUNNEL_URL_FILE:-$ROOT/src/data/tunnel-public-url.txt}"
PORT="${GEMIX_TEMP_FILE_PORT:-9998}"
SUBDOMAIN="${LT_SUBDOMAIN:-}"

mkdir -p "$(dirname "$URL_FILE")"

LT_ARGS=(--port "$PORT")
if [[ -n "$SUBDOMAIN" ]]; then
  LT_ARGS+=(--subdomain "$SUBDOMAIN")
fi

echo "[Tunnel] Starting localtunnel on port $PORT (url file: $URL_FILE)"
exec npx --yes localtunnel "${LT_ARGS[@]}" 2>&1 | while IFS= read -r line; do
  printf '%s\n' "$line"
  if [[ "$line" =~ your[[:space:]]url[[:space:]]is:[[:space:]]*(https?://[^[:space:]]+) ]]; then
    url="${BASH_REMATCH[1]}"
    url="${url%/}"
    printf '%s\n' "$url" > "$URL_FILE"
    echo "[Tunnel] Wrote public URL to $URL_FILE"
  fi
done