# GemiX Python sandbox

This folder contains everything needed to build and run the isolated Python
environment used by the `code_execution` / `write_file` / `edit_file` / `bash`
tools.

## Layout

```
sandbox/
├── Dockerfile                  # main sandbox image
├── requirements-sandbox.txt    # pinned Python libraries preinstalled inside
├── entrypoint.sh               # starts jupyter_server on :8888
├── preload_models.py           # runs at build-time: downloads rembg u2net
├── docker-compose.yml          # reference topology for local testing
├── proxy/
│   ├── Dockerfile              # tiny alpine image for the egress proxy
│   └── proxy.py                # allowlist-enforcing HTTP(S) proxy
└── README.md                   # this file
```

## Building the images

Run these once on the Linux server (or after every edit to the Dockerfile /
requirements):

```bash
# 1. main sandbox image (big: ~2 GB because of scipy/astropy/moviepy wheels
#    plus ffmpeg/tesseract system packages). First build takes a while because
#    rembg downloads the u2net model — that's expected.
docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox

# 2. egress proxy (small: ~60 MB)
docker build -t gemix-sandbox-proxy:latest -f sandbox/proxy/Dockerfile sandbox/proxy
```

## Networks

Two docker networks are expected by the Node sandbox manager:

- `gemix_sandbox_net` — `internal: true`. Sandboxes attach here. They have
  **no** direct route to the internet.
- `gemix_sandbox_egress` — normal bridge. **Only** the proxy container
  attaches here; it is the single egress point.

You can create them with:

```bash
docker network create --internal gemix_sandbox_net
docker network create gemix_sandbox_egress
```

## Proxy allowlist

The proxy (`proxy/proxy.py`) refuses every outbound host by default and only
forwards traffic to:

- `api.polygon.io` (and any subdomain of `polygon.io`) — finance data
- `data.astropy.org`, `*.stsci.edu`, `*.ipac.caltech.edu`, `*.cds.unistra.fr`,
  `*.gsfc.nasa.gov`, `*.eso.org`, `*.noirlab.edu` — astropy / astroquery data

Override by setting the `ALLOWED_HOSTS` environment variable on the proxy
container. Use comma-separated entries; prefix with `.` for suffix-match.
Example:

```
ALLOWED_HOSTS=.polygon.io,data.astropy.org,files.example.com
```

Each match is logged as a single-line `event=allow_connect host=... port=...`
or `event=deny_*`. Tail the proxy container to audit traffic.

## Running one sandbox by hand

The Node side handles this automatically; these commands are for local
experimentation only.

```bash
# Start the proxy once (shared by all sandboxes)
docker run -d --name gemix-proxy \
    --network gemix_sandbox_egress \
    gemix-sandbox-proxy:latest
docker network connect gemix_sandbox_net gemix-proxy

# Start one sandbox bound to a project folder
PROJECT=/abs/path/to/user/projects/my_proj
TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(32))")
docker run --rm -it \
    --network gemix_sandbox_net \
    --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 200 --memory 1536m --memory-swap 1536m --cpus 1 \
    -e SANDBOX_TOKEN="$TOKEN" \
    -e HTTP_PROXY=http://gemix-proxy:8080 \
    -e HTTPS_PROXY=http://gemix-proxy:8080 \
    -e NO_PROXY=localhost,127.0.0.1 \
    -v "$PROJECT":/workspace \
    gemix-sandbox:latest
```

The kernel is then reachable from the host (if you also publish `-p 8888:8888`)
at `http://localhost:8888/?token=$TOKEN`.

## Security model in one page

| Threat                             | Mitigation                                        |
|------------------------------------|---------------------------------------------------|
| Escape container                   | `--cap-drop=ALL`, `no-new-privileges`, non-root   |
| Fork bomb                          | `--pids-limit=200`                                |
| Memory exhaustion                  | `--memory=1.5g`, `--memory-swap=1.5g`             |
| CPU DOS                            | `--cpus=1`                                        |
| Arbitrary internet access          | `sandbox_net` internal + proxy allowlist          |
| `pip install <malicious>`          | pip stub returns exit 1; deps are baked           |
| Read user's private files outside  | Bind mounts only the current project + ro zones  |
| Persistent state leak across users | Container per `(storageId, project)`, killed idle |
| Long-running script                | Per-call timeout (default 30s, max 120s)          |
| Unbounded stdout                   | 512 KB cap + `output_truncated: true` flag        |
| Big generated files                | Attachments carry filePath (lazy), 100 MB cap     |

## UID mapping (IMPORTANT on Linux)

The sandbox runs as `uid=1000` (`sandbox` user). For bind mounts to be
writable, the project directory on the host must be owned by UID 1000 too.
Options:

- Create the Node process user with `uid=1000` (recommended, simplest).
- Or `chown -R 1000:1000 data/users/<id>/projects/<slug>` before the first
  sandbox call for a project. The Node `sandboxManager` will do this
  automatically (Phase C.3) using `fs.chown` when running as root, or emit a
  clear error otherwise.

On Windows / macOS development hosts this is handled by Docker Desktop and
no manual action is required.

## Operational knobs

All tunable from `src/config/constants.js`:

- `CODE_EXEC_TIMEOUT_MS`, `CODE_EXEC_MAX_TIMEOUT_MS`
- `CODE_EXEC_MAX_OUTPUT_BYTES`, `CODE_EXEC_MAX_FILES_PER_CALL`,
  `CODE_EXEC_MAX_TOTAL_BYTES`
- `SANDBOX_MEMORY_MB`, `SANDBOX_IDLE_TTL_MS`
- `MAX_PROJECT_SIZE_MB`

Change them on the host side and restart the bot — no rebuild needed.
