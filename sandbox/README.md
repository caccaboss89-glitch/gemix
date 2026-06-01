# GemiX sandbox

Container Docker usato dal sub-agent `build`. Una sola immagine
(`gemix-sandbox:latest`) + un proxy egress (`gemix-sandbox-proxy:latest`).

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
  le network) - unico ponte tra il sandbox network e Internet
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

```bash
docker rm -f gemix-sandbox-proxy 2>/dev/null || true

docker run -d \
  --name gemix-sandbox-proxy \
  --restart unless-stopped \
  --network gemix_sandbox_egress \
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
| Allowlist proxy (`ALLOWED_HOSTS`) | ricreare il container del proxy con la nuova env |

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

Il container gira come UID `1000` (`sandbox`).

Per i bind mount writable (`/workspace`), la cartella host deve essere
accessibile in scrittura da UID `1000`. Quando il bot gira come root il
buildSandbox fa `chown 1000:1000` automaticamente; quando gira come utente
non-root applica `chmod 0777` ricorsivo sull'albero del workspace. Il
container è cap-dropped, network-isolated, memory-capped, quindi il chmod
permissivo è limitato al solo subtree dell'utente/gruppo.

### Override runtime

Variabili d'ambiente che il `buildSandbox` riconosce:

- `DOCKER_HOST`
- `GEMIX_SANDBOX_IMAGE`
- `GEMIX_SANDBOX_NETWORK`
- `GEMIX_SANDBOX_PROXY_HOST`
- `GEMIX_SANDBOX_PROXY_PORT`

In assenza di motivi specifici, lascia i default.

## Allowlist del proxy

Il proxy nega il traffico in uscita per default e inoltra solo verso gli
host nell'allowlist (`sandbox/proxy/proxy.py`, override via env
`ALLOWED_HOSTS`). I default coprono YouTube, X/Twitter (`x.com`,
`api.x.com`, `twimg.com`, `t.co`), Instagram, TikTok, Facebook (necessari
per `yt-dlp`).

I log del proxy registrano `event=allow_*` o `event=deny_*` per ogni
richiesta - controllarli è il modo più rapido per capire perché un download
sta fallendo.

## Avviare manualmente una sandbox (debug)

Il runtime gestisce tutto da solo. Questi comandi servono solo per verifiche
manuali:

```bash
WORKSPACE=/abs/path/to/data/users/user_<sanitized>/build_workspace

docker run --rm -it \
  --network gemix_sandbox_net \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 200 \
  --memory 1536m \
  --memory-swap 1536m \
  --cpus 1 \
  --user 1000:1000 \
  --entrypoint '' \
  -e HTTP_PROXY=http://gemix-sandbox-proxy:8080 \
  -e HTTPS_PROXY=http://gemix-sandbox-proxy:8080 \
  -v "$WORKSPACE":/workspace:rw \
  -v "$(pwd)/src/data/skills":/skills:ro \
  gemix-sandbox:latest \
  /bin/bash
```

## Costanti operative (host)

In `src/config/constants.js`, modificabili con un solo restart del bot:

- `SANDBOX_MEMORY_MB` (default 1536)
- `SANDBOX_IDLE_TTL_MS` (default 15 min - quando un container è idle)
- `BUILD_WORKSPACE_TTL_MS` (default 4h - quando il workspace si svuota)
- `BUILD_WORKSPACE_QUOTA_MB` (default 500 MB)
- `BUILD_MAX_ROUNDS` / `BUILD_HARD_TIMEOUT_MS` / `BUILD_LOCK_WAIT_MS`
