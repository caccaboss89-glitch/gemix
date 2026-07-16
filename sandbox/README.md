# GemiX sandbox

Container Docker usato dal tool `build` (Grok Build CLI in-container). Una sola
immagine (`gemix-sandbox:latest`) + un proxy egress (`gemix-sandbox-proxy:latest`).

**Grok CLI** è installato **nell'immagine** (`npm i -g @xai-official/grok` in
`Dockerfile`). Non va reinstallato a ogni `docker create`, e **non** è richiesto
sul host per la produzione (solo Docker). Per aggiornare il CLI: rebuild
immagine + `pm2 restart GemiX`. Auth: GemiX inietta `XAI_API_KEY` da
`getXaiAuth()` (Hermes OAuth o API key) **solo** sull'`exec` di `grok`, senza
montare `~/.hermes` / `~/.grok` host.

In produzione i container **non** vengono avviati con `docker compose`. Sono
creati on-demand da `src/sandbox/buildSandbox.js`, uno per `workspaceId`
(utente o gruppo), e distrutti dopo `SANDBOX_IDLE_TTL_MS` di inattività o
quando il workspace supera la sua TTL globale (4h dall'ultima interazione).

## Cosa il runtime si aspetta

- Docker Engine raggiungibile dal processo bot
  - default: `/var/run/docker.sock`
  - override: `DOCKER_HOST`
- immagine `gemix-sandbox:latest` già buildata
- immagine `gemix-sandbox-proxy:latest` già buildata
- network Docker `gemix_sandbox_net` esistente (internal)
- network Docker `gemix_sandbox_egress` esistente (bridge normale)
- container proxy `gemix-sandbox-proxy` in esecuzione (collegato a entrambe
  le network) - unico ponte tra il sandbox network e Internet, che inoltra
  l'egress al SOCKS5 residenziale (tailsocks → Redmi)
- l'utente che esegue GemiX deve poter parlare con Docker

Se manca uno di questi, la prima chiamata `build` fallisce in `getOrCreate()`.

## Layout cartella

```text
sandbox/
├── Dockerfile
├── requirements-sandbox.txt
├── preload_models.py
├── docker-compose.yml    (riferimento manuale, non usato in prod)
├── proxy/
│   ├── Dockerfile
│   └── proxy.py
└── README.md
```

## Setup iniziale (Linux)

### 1. Installare Docker

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

### 2. Permettere all'utente del bot di parlare con Docker

```bash
sudo usermod -aG docker <bot_user>
newgrp docker
docker ps    # verifica
```

Errori tipo `EACCES /var/run/docker.sock` significano che l'utente del
servizio (PM2/systemd) non è nel gruppo `docker`. Aggiungi quello, non solo
l'utente SSH.

### 3. Buildare le immagini

Dalla root del repo:

```bash
docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
docker build -t gemix-sandbox-proxy:latest -f sandbox/proxy/Dockerfile sandbox/proxy
```

L'immagine principale ci mette parecchio (Texlive, LibreOffice, fonts).

### 4. Creare le network

```bash
docker network inspect gemix_sandbox_net    >/dev/null 2>&1 || docker network create --internal gemix_sandbox_net
docker network inspect gemix_sandbox_egress >/dev/null 2>&1 || docker network create gemix_sandbox_egress
```

### 5. Avviare il proxy

Il proxy inoltra tutto l'egress upstream al SOCKS5 residenziale (tailsocks →
Redmi). Su Linux con rete `gemix_sandbox_egress` dedicata:

- tailsocks di solito ascolta solo su `127.0.0.1:5040` → relay **socat** +
  regole **iptables** sul bridge egress (vedi **SERVER_SETUP.md §1**);
- `REDMI_SOCKS_HOST` = gateway della rete egress (es. `172.19.0.1`), **non**
  `host.docker.internal`.

```bash
EGRESS_GW=$(docker network inspect gemix_sandbox_egress -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')

docker rm -f gemix-sandbox-proxy 2>/dev/null || true

docker run -d \
  --name gemix-sandbox-proxy \
  --restart unless-stopped \
  --network gemix_sandbox_egress \
  -e REDMI_SOCKS_HOST="$EGRESS_GW" \
  -e REDMI_SOCKS_PORT=5040 \
  -e GEMIX_NOTIFY_URL="http://${EGRESS_GW}:9999/notify" \
  gemix-sandbox-proxy:latest

docker network connect gemix_sandbox_net gemix-sandbox-proxy 2>/dev/null || true
```

### 6. Avviare GemiX

```bash
pm2 restart GemiX
```

La prima chiamata `build` materializza il container del sandbox. Le successive
lo riusano.

## Quando rebuildare

| Cambia | Azione |
| :--- | :--- |
| File JS sotto `src/` | restart GemiX, niente Docker rebuild |
| `sandbox/Dockerfile` / `requirements-sandbox.txt` / `preload_models.py` | rebuild `gemix-sandbox:latest` + restart GemiX || `sandbox/proxy/*` | rebuild `gemix-sandbox-proxy:latest` + ricreare il container del proxy + restart GemiX |
| Endpoint SOCKS upstream (`REDMI_SOCKS_HOST`/`REDMI_SOCKS_PORT`) | ricreare il container del proxy con la nuova env |

Esempio rebuild sandbox principale:

```bash
docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
pm2 restart GemiX
# Le sandbox ancora vive con la vecchia immagine vengono distrutte dallo
# shutdown hook al restart; le successive useranno l'immagine aggiornata.
```

## Note operative

### Container PID 1

L'image non ha `ENTRYPOINT` né `CMD`: il `buildSandbox` lo passa esplicitamente
(`Cmd:['sleep','infinity']`) al boot, così il container resta un processo idle a
cui ci si attacca con `docker exec`. Se lanci il container a mano per debug,
ricordati di passare `--entrypoint ""` e un comando esplicito (vedi sezione
"Avviare manualmente una sandbox").

### UID nel container

A runtime il container usa **UID/GID del processo Node host** (`sandboxUserString()`),
non necessariamente l'utente `sandbox` (1000) del Dockerfile (che viene sovrascritto
da `User` al create). Fallback `1000:1000` solo fuori da Linux.

Per i bind mount writable (`/workspace`), la cartella host deve essere
scrivibile da quell'UID. Con bot root, `ensureWorkspaceWritable` allinea ownership;
con bot non-root applica chmod dove possibile. Il container è cap-dropped,
network-isolated, memory-capped.

### Override runtime

Variabili d'ambiente che il `buildSandbox` riconosce:

- `DOCKER_HOST`
- `GEMIX_SANDBOX_IMAGE`
- `GEMIX_SANDBOX_NETWORK`
- `GEMIX_SANDBOX_PROXY_HOST`
- `GEMIX_SANDBOX_PROXY_PORT`

In assenza di motivi specifici, lascia i default.

## Egress (proxy → SOCKS5 residenziale)

Tutto il traffico in uscita del container build (`curl`/`wget`/`yt-dlp`/
`requests`/Python) passa per `gemix-sandbox-proxy`, che inoltra ogni connessione
**upstream** al SOCKS5 residenziale `tailsocks` (Redmi 10C via Tailscale), con
DNS risolto lato Redmi (socks5h). Così l'IP residenziale bypassa i blocchi
anti-datacenter, mantenendo un unico chokepoint con logging.

- **Nessuna allowlist:** qualunque host è raggiungibile. `yt-dlp` è installato
  nell'immagine (`Dockerfile`) e gira in-container come ogni altro comando —
  niente più esecuzione host-side.
- **Fail-closed:** nessun fallback su internet diretto. Se il Redmi/tailsocks è
  giù, il container resta senza internet; i download falliscono con errore
  proxy/502 e il sub-agent lo segnala come guasto di sistema senza riprovare.
- **Config:** env `REDMI_SOCKS_HOST` / `REDMI_SOCKS_PORT` sul container proxy
  (default `host.docker.internal:5040`); il container deve poter raggiungere
  tailsocks (vedi SERVER_SETUP.md §1).

I log del proxy registrano `event=allow_connect` / `event=allow_http` per ogni
richiesta e `event=upstream_fail` quando l'egress residenziale non risponde.

**Test rapido del SOCKS residenziale (sull'host):**

```bash
ss -tlnp | grep 5040
yt-dlp --simulate --print "%(title)s" --proxy socks5h://127.0.0.1:5040 "URL_YOUTUBE"
```

## Avviare manualmente una sandbox (debug)

Il runtime gestisce tutto da solo. Questi comandi servono solo per verifiche
manuali:

```bash
WORKSPACE=/abs/path/to/data/users/user_<sanitized>/build_workspace

# Usa lo stesso UID del processo bot se non sei root (es. $(id -u):$(id -g)).
docker run --rm -it \
  --network gemix_sandbox_net \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 200 \
  --memory 1536m \
  --memory-swap 1536m \
  --cpus 1 \
  --user "$(id -u):$(id -g)" \
  --entrypoint '' \
  -e HTTP_PROXY=http://gemix-sandbox-proxy:8080 \
  -e HTTPS_PROXY=http://gemix-sandbox-proxy:8080 \
  -e HOME=/var/lib/gemix-grok \
  -e GROK_HOME=/var/lib/gemix-grok \
  -v "$WORKSPACE":/workspace:rw \
  gemix-sandbox:latest \
  /bin/bash
```

(Nessun mount di skill pack GemiX: Grok Build usa le skill del CLI.)

## Costanti operative (host)

In `src/config/constants.js`, modificabili con un solo restart del bot:

- `SANDBOX_MEMORY_MB` (default 1536)
- `SANDBOX_IDLE_TTL_MS` (default 15 min - quando un container è idle)
- `BUILD_WORKSPACE_TTL_MS` (default 4h - quando il workspace si svuota)
- `BUILD_WORKSPACE_QUOTA_MB` (default 500 MB)
- `BUILD_MAX_ROUNDS` / `BUILD_HARD_TIMEOUT_MS` / `BUILD_LOCK_WAIT_MS`
