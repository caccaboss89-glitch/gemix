# GemiX sandbox image.
# Build: docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
# Run: managed by src/sandbox/workspaceRuntime.js, which boots the container
#      with the quota monitor as PID 1 and attaches per-call via `docker exec`.
#      Bind mounts: /workspace (rw, this conversation's own files) and
#      /attachments (ro, the host projection of the chat's files).
#      No agent CLI is baked in: the main agent runs the tools itself and only
#      uses the container to execute shell commands.

FROM python:3.12-slim-bookworm

# -- System packages -------------------------------------------------------
# Build tools (gcc/g++/make, python3-dev, libpq-dev) are needed by a few wheels.
# Kept installed - no pip at runtime so this does not widen the attack surface.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        libcairo2 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        poppler-utils \
        libpq-dev \
        gcc \
        g++ \
        make \
        python3-dev \
        fonts-dejavu-core \
        curl \
        wget \
        ghostscript \
        lmodern \
        texlive-latex-recommended \
        texlive-latex-extra \
        texlive-fonts-recommended \
        texlive-fonts-extra \
        texlive-science \
        texlive-lang-italian \
        cm-super \
        dvipng \
        libreoffice-calc \
        libreoffice-writer \
        libreoffice-impress \
        libreoffice-core \
        libreoffice-common \
        libreoffice-java-common \
        default-jre-headless \
        ffmpeg \
        zip \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# -- Python dependencies ---------------------------------------------------
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DEFAULT_TIMEOUT=120

WORKDIR /opt/sandbox
COPY requirements-sandbox.txt preload_models.py quota_guard.py quota_exec.py /opt/sandbox/
RUN chmod 0555 /opt/sandbox/quota_guard.py /opt/sandbox/quota_exec.py
RUN pip install --no-cache-dir --retries 5 --timeout 120 -r /opt/sandbox/requirements-sandbox.txt

# -- unoserver for LibreOffice field updates (TOC, indexes) ------------------
RUN pip install --no-cache-dir --retries 5 --timeout 120 unoserver

# -- yt-dlp (media downloads) -----------------------------------------------
# Installed at build time (pip is disabled at runtime below). Left unpinned on
# purpose: extractors must stay current with site changes, so a fresh copy is
# pulled on every image rebuild. All its traffic exits via the egress proxy,
# which reaches the internet on the host's own residential line, so
# anti-datacenter blocks do not apply.
RUN pip install --no-cache-dir --retries 5 --timeout 120 yt-dlp

# -- Node.js + common JS tooling -------------------------------------------
# For scripts the model writes and runs under /workspace. The pptxgenjs / docx
# stack is here so document generation needs no install at runtime.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g --no-fund --no-audit \
        pptxgenjs \
        react-icons \
        react \
        react-dom \
        sharp \
        docx@9.7.1 \
        docxtemplater@3.68.7 \
        pizzip@3.2.0 \
        angular-expressions@1.5.5 \
    && npm cache clean --force

# Writable exec-capable HOME. The path must match containerEnv() in
# workspaceRuntime.js, which sets HOME on every exec — a mismatch would leave
# the preloaded caches below outside the home the tools actually use.
# Must NOT be a noexec tmpfs mount.
RUN mkdir -p /var/lib/gemix-workspace \
    && chmod 1777 /var/lib/gemix-workspace

ENV HOME=/var/lib/gemix-workspace \
    NODE_PATH=/usr/lib/node_modules

# -- Preload heavy models at build time (offline runtime) ------------------
RUN python /opt/sandbox/preload_models.py

# -- Non-root sandbox user -----------------------------------------------
RUN useradd --create-home --uid 1000 --shell /bin/bash sandbox \
    && mkdir -p /workspace \
    && chown -R sandbox:sandbox /workspace /home/sandbox

# rembg caches under $HOME/.u2net during preload (HOME set above). Runtime HOME
# is the same path, so leave the models there; only make sure the sandbox user
# can read them, since preload runs as root.
RUN if [ -d /var/lib/gemix-workspace/.u2net ]; then \
        chmod -R a+rX /var/lib/gemix-workspace/.u2net; \
    fi

# Disable pip at runtime so the AI cannot install arbitrary packages.
# We replace every pip entry point with a refusal stub. The stub is owned by
# root (755) and the sandbox user cannot overwrite it.
RUN printf '#!/bin/sh\necho "pip is disabled inside the GemiX sandbox." >&2\nexit 1\n' \
        > /usr/local/bin/pip \
    && chmod 755 /usr/local/bin/pip \
    && rm -f /usr/local/bin/pip3 /usr/local/bin/pip3.12 \
    && ln -s /usr/local/bin/pip /usr/local/bin/pip3 \
    && ln -s /usr/local/bin/pip /usr/local/bin/pip3.12

# Disable npm/npx at runtime for the same reason (Node packages are baked in at
# build time only). `node` itself stays available to run the pptx templates.
# We drop any npm/npx entry points on PATH and replace them with a root-owned
# refusal stub (755) that the sandbox user cannot overwrite.
RUN for bin in npm npx; do \
        for p in /usr/bin/$bin /usr/local/bin/$bin; do rm -f "$p"; done; \
        printf '#!/bin/sh\necho "%s is disabled inside the GemiX sandbox." >&2\nexit 1\n' "$bin" \
            > /usr/local/bin/$bin; \
        chmod 755 /usr/local/bin/$bin; \
    done

USER sandbox
WORKDIR /workspace

ENV SANDBOX_WORKDIR=/workspace \
    SANDBOX_USER=sandbox \
    GEMIX_SANDBOX=1 \
    MPLBACKEND=Agg

# No ENTRYPOINT and no CMD: the runtime supplies the quota monitor as PID 1.
