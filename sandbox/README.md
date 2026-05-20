# GemiX Python sandbox

This folder contains the Dockerized Python sandbox used by the `bash`,
`write_file`, and `edit_file` tools. (Ad-hoc Python without filesystem access
goes through the xAI server-side `code_interpreter` instead.)

In production the containers are **not** started through `docker compose`.
They are created lazily by `src/sandbox/sandboxManager.js`, one container per
active `(storageId, project)` pair, and automatically destroyed when idle.

This README focuses on the practical operations you need on the Linux server:

- first-time setup
- fixing Docker socket permission errors
- rebuilding the sandbox after dependency changes
- knowing when a bot restart is enough and when a Docker rebuild is required

## What the runtime expects

The current Node runtime expects all of the following:

- Docker Engine reachable by the bot process
  - default: `/var/run/docker.sock`
  - optional override: `DOCKER_HOST`
- image `gemix-sandbox:latest` already built
- image `gemix-sandbox-proxy:latest` already built
- Docker network `gemix_sandbox_net` already created as `internal`
- Docker network `gemix_sandbox_egress` already created as a normal bridge
- proxy container running with the name `gemix-sandbox-proxy`
  - unless you override `GEMIX_SANDBOX_PROXY_HOST`
- the user running GemiX must be allowed to talk to Docker

If one of these is missing, the first sandbox tool call will fail during
`getOrCreate()`.

## Folder layout

```text
sandbox/
├── Dockerfile
├── requirements-sandbox.txt
├── entrypoint.sh
├── preload_models.py
├── docker-compose.yml
├── proxy/
│   ├── Dockerfile
│   └── proxy.py
└── README.md
```

## First-time setup on a Linux server

### 1. Install Docker

Example for Debian / Ubuntu servers:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
docker --version
```

If your distro uses different package names, adapt accordingly.

### 2. Make sure the **same user that runs GemiX** can access Docker

This is the fix for errors such as:

```text
connect EACCES /var/run/docker.sock
```

That error does **not** mean Docker is missing. It usually means the bot
process user does not have permission to use the Docker socket.

Typical fix:

```bash
sudo usermod -aG docker <bot_user>
```

Then fully refresh that user's session before restarting the bot:

```bash
newgrp docker
docker ps
```

Important notes:

- If GemiX is started by `pm2`, `systemd`, or another service manager, add the
  **service user**, not just your SSH login user.
- If `docker ps` works in your shell but GemiX still gets `EACCES`, the bot is
  probably running as a different user.
- You can confirm the socket permissions with:

```bash
ls -l /var/run/docker.sock
```

### 3. Build the images

Run these in the repository root:

```bash
docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
docker build -t gemix-sandbox-proxy:latest -f sandbox/proxy/Dockerfile sandbox/proxy
```

Notes:

- The main sandbox image is the large one.
- The first build takes a while.
- `preload_models.py` downloads the rembg model during build; that is expected.

### 4. Create the required Docker networks

Use idempotent commands so re-running them is safe:

```bash
docker network inspect gemix_sandbox_net >/dev/null 2>&1 || docker network create --internal gemix_sandbox_net
docker network inspect gemix_sandbox_egress >/dev/null 2>&1 || docker network create gemix_sandbox_egress
```

Network roles:

- `gemix_sandbox_net`
  - internal-only network
  - sandboxes attach here
  - no direct internet access
- `gemix_sandbox_egress`
  - normal bridge network
  - only the proxy needs outbound internet here

### 5. Start the proxy container

The runtime expects the proxy to be reachable as `gemix-sandbox-proxy` on the
internal sandbox network.

```bash
docker rm -f gemix-sandbox-proxy 2>/dev/null || true

docker run -d \
  --name gemix-sandbox-proxy \
  --restart unless-stopped \
  --network gemix_sandbox_egress \
  gemix-sandbox-proxy:latest

docker network connect gemix_sandbox_net gemix-sandbox-proxy 2>/dev/null || true
```

### 6. Restart GemiX

After the first-time setup, restart the bot so future sandbox requests can
reach Docker and create containers correctly.

Examples:

```bash
pm2 restart GemiX
```

or:

```bash
sudo systemctl restart gemix
```

### 7. Run a smoke test

Ask GemiX to execute a simple sandbox action, for example a trivial Python
calculation or a simple shell command in a project. If the setup is correct,
the first request will boot the sandbox and the next ones will reuse it.

## Update / rebuild playbook

### Case A: only host-side JavaScript logic changed

Examples:

- files under `src/`
- prompt/tool descriptions
- timeouts or quotas in `src/config/constants.js`
- sandbox manager logic in `src/sandbox/*.js`

Action:

- restart GemiX
- **no Docker rebuild needed**

### Case B: sandbox image contents changed

Rebuild the main sandbox image when you change any of these:

- `sandbox/Dockerfile`
- `sandbox/requirements-sandbox.txt`
- `sandbox/entrypoint.sh`
- `sandbox/preload_models.py`
- any dependency baked into the image
  - for example after adding a new package or CLI tool such as `yt-dlp`

Commands:

```bash
docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
pm2 restart GemiX
```

If you do not use PM2, restart the service with your normal process manager.

Important:

- rebuilding the image only updates what is installed inside the container
- if the new dependency also needs outbound network access to new domains,
  you must update the proxy allowlist too
- example: adding a downloader such as `yt-dlp` may require both
  - rebuilding `gemix-sandbox:latest`
  - updating the proxy rules / `ALLOWED_HOSTS` so the required hosts are allowed

Why the restart matters:

- running sandbox containers keep using the old image until they are destroyed
- restarting GemiX triggers sandbox cleanup through the shutdown logic
- the next sandbox request will create fresh containers from the rebuilt image

### Case C: proxy image or allowlist logic changed

Rebuild and recreate the proxy when you change:

- `sandbox/proxy/Dockerfile`
- `sandbox/proxy/proxy.py`

Commands:

```bash
docker build -t gemix-sandbox-proxy:latest -f sandbox/proxy/Dockerfile sandbox/proxy
docker rm -f gemix-sandbox-proxy

docker run -d \
  --name gemix-sandbox-proxy \
  --restart unless-stopped \
  --network gemix_sandbox_egress \
  gemix-sandbox-proxy:latest

docker network connect gemix_sandbox_net gemix-sandbox-proxy 2>/dev/null || true
pm2 restart GemiX
```

### Case D: only proxy allowlist environment changed

If you only changed `ALLOWED_HOSTS`, you can recreate the proxy container with
the new environment value. No main sandbox rebuild is needed.

Example:

```bash
docker rm -f gemix-sandbox-proxy

docker run -d \
  --name gemix-sandbox-proxy \
  --restart unless-stopped \
  --network gemix_sandbox_egress \
  -e ALLOWED_HOSTS='files.example.com' \
  gemix-sandbox-proxy:latest

docker network connect gemix_sandbox_net gemix-sandbox-proxy 2>/dev/null || true
pm2 restart GemiX
```

## Manual checks after an update

Useful commands:

```bash
docker images | grep gemix-sandbox
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
docker logs --tail 100 gemix-sandbox-proxy
```

If you want to inspect currently running sandbox containers:

```bash
docker ps --filter "name=gemix-sb-"
```

## Proxy allowlist

The proxy denies outbound traffic by default and only forwards to the hosts
allowed by `proxy/proxy.py` or by `ALLOWED_HOSTS`.

Default intent:

- any extra hosts you explicitly allow

Each decision is logged as `event=allow_*` or `event=deny_*`, so checking the
proxy logs is the quickest way to understand why an outbound request failed.

## Running one sandbox by hand

The Node runtime normally handles this automatically. The commands below are
only for manual testing.

```bash
PROJECT=/abs/path/to/data/users/<storageId>/projects/<slug>
TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")

docker run --rm -it \
  --network gemix_sandbox_net \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 200 \
  --memory 1536m \
  --memory-swap 1536m \
  --cpus 1 \
  -e SANDBOX_TOKEN="$TOKEN" \
  -e HTTP_PROXY=http://gemix-sandbox-proxy:8080 \
  -e HTTPS_PROXY=http://gemix-sandbox-proxy:8080 \
  -e NO_PROXY=localhost,127.0.0.1 \
  -v "$PROJECT":/workspace:rw \
  gemix-sandbox:latest
```

If you also publish `-p 8888:8888`, the Jupyter server becomes reachable at:

```text
http://localhost:8888/?token=<TOKEN>
```

## UID mapping on Linux

The container runs as `uid=1000` (`sandbox`).

For bind mounts to be writable, the project directory on the host should also
be writable by UID `1000`.

Recommended options:

- run the bot with a Linux user whose UID is `1000`
- or pre-chown the relevant user/project directories to `1000:1000`

Example:

```bash
sudo chown -R 1000:1000 data/users
```

The Node sandbox manager only attempts host-side `chown` automatically when the
bot itself is running as root on Linux. In normal non-root deployments, you are
responsible for the ownership setup.

## Optional runtime overrides

These environment variables can override the defaults used by
`src/sandbox/sandboxManager.js`:

- `DOCKER_HOST`
- `GEMIX_SANDBOX_IMAGE`
- `GEMIX_SANDBOX_NETWORK`
- `GEMIX_SANDBOX_PROXY_HOST`
- `GEMIX_SANDBOX_PROXY_PORT`

Unless you intentionally changed the topology, keeping the defaults is simpler.

## Reference `docker-compose.yml`

`sandbox/docker-compose.yml` is only a reference topology for local validation.
Production does not rely on it for lifecycle management.

It is still useful when you want to verify the image and proxy manually:

```bash
docker compose -f sandbox/docker-compose.yml up --build
```

## Operational knobs

These are controlled on the host side in `src/config/constants.js` and only
require a bot restart, not a Docker rebuild:

- `CODE_EXEC_TIMEOUT_MS`
- `CODE_EXEC_MAX_TIMEOUT_MS`
- `CODE_EXEC_MAX_OUTPUT_BYTES`
- `CODE_EXEC_MAX_FILES_PER_CALL`
- `CODE_EXEC_MAX_TOTAL_BYTES`
- `SANDBOX_MEMORY_MB`
- `SANDBOX_IDLE_TTL_MS`
- `MAX_USER_TOTAL_MB`
