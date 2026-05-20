#!/usr/bin/env bash
# GemiX sandbox container entrypoint.
# Starts a headless Jupyter Server whose single kernel is the stateful Python
# REPL used by the bash, write_file, and edit_file tools. The Node side
# connects via HTTP+WS on port 8888 and identifies itself with SANDBOX_TOKEN.
# (code_interpreter is xAI server-side; this sandbox is for workspace file operations only.)

set -euo pipefail

: "${SANDBOX_TOKEN:?SANDBOX_TOKEN env var is required}"
: "${SANDBOX_USER:=sandbox}"
: "${SANDBOX_WORKDIR:=/workspace}"

cd "${SANDBOX_WORKDIR}"

# Mark that we are inside the sandbox (skills, prompts, and Python code can read this).
export GEMIX_SANDBOX=1

# Bootstrap user-level config (matplotlib etc. may want writable cache)
mkdir -p "$HOME/.config" "$HOME/.cache" || true

echo "--- GemiX Sandbox Bootstrapped ---"
echo "User: $(id)"
echo "Workdir: $(pwd)"
echo "Environment: GEMIX_SANDBOX=$GEMIX_SANDBOX"
echo "Starting Jupyter Server on port 8888..."

exec jupyter server \
  --ServerApp.ip=0.0.0.0 \
  --ServerApp.port=8888 \
  --IdentityProvider.token="${SANDBOX_TOKEN}" \
  --ServerApp.password='' \
  --ServerApp.disable_check_xsrf=True \
  --ServerApp.allow_remote_access=True \
  --ServerApp.allow_origin='*' \
  --ServerApp.root_dir="${SANDBOX_WORKDIR}" \
  --ServerApp.terminado_settings="shell_command=['/bin/bash']" \
  --ServerApp.log_level=INFO \
  --no-browser
