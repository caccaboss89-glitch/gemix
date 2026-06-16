# GemiX sandbox egress proxy.
# Tiny Python-only HTTP(S) proxy that forwards all sandbox egress upstream
# through the residential SOCKS5 (Redmi). No third-party deps.
# Build: docker build -t gemix-sandbox-proxy:latest -f sandbox/proxy/Dockerfile sandbox/proxy

FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN adduser -D -H -u 1000 proxy
WORKDIR /opt/proxy
COPY proxy.py /opt/proxy/proxy.py

USER proxy
EXPOSE 8080
ENV PROXY_PORT=8080
ENTRYPOINT ["python", "/opt/proxy/proxy.py"]
