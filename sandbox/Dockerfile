# GemiX sandbox image.
# Build: docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
# Run: managed by src/sandbox/buildSandbox.js, which boots the container with
#      Cmd: ['sleep', 'infinity'] and attaches per-call via `docker exec`.
#      Bind mounts: /workspace (rw, per-workspaceId build dir) and /skills (ro).

FROM python:3.12-slim-bookworm

# ── System packages ──
# Build tools (gcc/g++/make, python3-dev, libpq-dev) are needed by a few wheels.
# Kept installed — no pip at runtime so this does not widen the attack surface.
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
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ──
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/sandbox
COPY sandbox/requirements-sandbox.txt /opt/sandbox/requirements-sandbox.txt
RUN pip install --no-cache-dir -r /opt/sandbox/requirements-sandbox.txt

# ── unoserver for LibreOffice field updates (TOC, indexes) ──
RUN pip install --no-cache-dir unoserver

# ── Preload heavy models at build time (offline runtime) ──
COPY sandbox/preload_models.py /opt/sandbox/preload_models.py
RUN python /opt/sandbox/preload_models.py

# ── Non-root sandbox user ──
RUN useradd --create-home --uid 1000 --shell /bin/bash sandbox \
    && mkdir -p /workspace /skills \
    && chown -R sandbox:sandbox /workspace /home/sandbox

# rembg caches under $HOME/.u2net — move it to the sandbox user's home so it is
# available without re-downloading when we switch user below.
RUN if [ -d /root/.u2net ]; then \
        mkdir -p /home/sandbox/.u2net && \
        cp -r /root/.u2net/. /home/sandbox/.u2net/ && \
        chown -R sandbox:sandbox /home/sandbox/.u2net; \
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

USER sandbox
WORKDIR /workspace

ENV SANDBOX_WORKDIR=/workspace \
    SANDBOX_USER=sandbox \
    GEMIX_SANDBOX=1 \
    MPLBACKEND=Agg

# No ENTRYPOINT and no CMD: the build manager always provides Cmd:['sleep','infinity']
# at run time. Leaving the image without a default avoids confusion if someone
# launches the container manually for debugging.
