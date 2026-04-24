# GemiX Python sandbox image.
# Build: docker build -t gemix-sandbox:latest -f sandbox/Dockerfile sandbox
# Run (managed by the Node sandboxManager):
#   docker run --rm --network=gemix_sandbox_net \
#              --cap-drop=ALL --security-opt=no-new-privileges \
#              --pids-limit=200 --memory=1536m --memory-swap=1536m --cpus=1 \
#              -e SANDBOX_TOKEN=<random> \
#              -e HTTP_PROXY=http://gemix-sandbox-proxy:8080 \
#              -e HTTPS_PROXY=http://gemix-sandbox-proxy:8080 \
#              -v <project_dir>:/workspace \
#              -v <user_readonly>:/readonly:ro \
#              gemix-sandbox:latest

FROM python:3.12-slim-bookworm

# ── System packages ──
# Build tools (gcc/g++/make, python3-dev, libpq-dev) are needed by a few wheels
# (e.g. qutip from source on some arches); keep them installed — no pip at runtime
# so this does not widen the attack surface for the AI.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        ffmpeg \
        tesseract-ocr \
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
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ──
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /opt/sandbox
COPY requirements-sandbox.txt /opt/sandbox/requirements-sandbox.txt
RUN pip install --no-cache-dir -r /opt/sandbox/requirements-sandbox.txt

# ── Preload heavy models at build time (offline runtime) ──
COPY preload_models.py /opt/sandbox/preload_models.py
RUN python /opt/sandbox/preload_models.py

# ── Non-root sandbox user ──
RUN useradd --create-home --uid 1000 --shell /bin/bash sandbox \
    && mkdir -p /workspace /readonly \
    && chown -R sandbox:sandbox /workspace /home/sandbox

# rembg caches under $HOME/.u2net — move it to the sandbox user's home so it is
# available without re-downloading when we switch user below.
RUN if [ -d /root/.u2net ]; then \
        mkdir -p /home/sandbox/.u2net && \
        cp -r /root/.u2net/. /home/sandbox/.u2net/ && \
        chown -R sandbox:sandbox /home/sandbox/.u2net; \
    fi

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Disable pip at build time so the AI cannot install arbitrary packages at runtime.
# We replace every pip entry point with a refusal stub. The stub is owned by
# root (755) and the sandbox user cannot overwrite it.
RUN printf '#!/bin/sh\necho "pip is disabled inside the GemiX sandbox." >&2\nexit 1\n' \
        > /usr/local/bin/pip \
    && chmod 755 /usr/local/bin/pip \
    && ln -sf /usr/local/bin/pip /usr/local/bin/pip3 \
    && ln -sf /usr/local/bin/pip /usr/local/bin/pip3.12

USER sandbox
WORKDIR /workspace
EXPOSE 8888

ENV SANDBOX_WORKDIR=/workspace \
    SANDBOX_USER=sandbox \
    GEMIX_SANDBOX=1 \
    MPLBACKEND=Agg

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
