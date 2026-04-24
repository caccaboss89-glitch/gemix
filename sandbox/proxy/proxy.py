"""
GemiX sandbox egress proxy.

Enforces a strict domain allowlist for outbound HTTP(S) traffic originating
from a sandbox container. This is the ONLY bridge between the sandbox network
and the outside world — the sandbox itself runs with no default route.

Protocol support:
- HTTP CONNECT  (HTTPS tunneling) — by far the common case (requests, httpx,
  polygon-api-client, astropy data downloads all use HTTPS).
- Plain HTTP GET/POST              — forwarded verbatim when host matches.

Allowlist rules:
- Matched against the request host (for CONNECT) or the Host header / URL
  (for plain HTTP).
- Match semantics: exact domain OR suffix match with a leading dot.
  Example: ".polygon.io" matches "api.polygon.io" and "files.polygon.io",
  but "api.polygon.io" only matches exactly.
- Configured via env var ALLOWED_HOSTS (comma-separated). Defaults cover
  polygon + common astropy/astroquery backends.

Operational:
- Listens on 0.0.0.0:${PROXY_PORT:-8080} (only reachable from the internal
  sandbox docker network).
- Structured log line for every request: allowed / denied, host, method, size.
- No per-client authentication — the internal docker network is the trust
  boundary. Do NOT expose this port to the host / internet.
"""

from __future__ import annotations

import os
import socket
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from typing import Iterable
from urllib.parse import urlparse

# ── Configuration ───────────────────────────────────────────────────────────

DEFAULT_ALLOWED = [
    # Polygon
    ".polygon.io",
    # Astropy / astroquery common data servers
    "data.astropy.org",
    ".stsci.edu",        # archive.stsci.edu, mast.stsci.edu, ...
    ".ipac.caltech.edu", # ned.ipac.caltech.edu, irsa.ipac.caltech.edu
    ".u-strasbg.fr",     # CDS mirrors (legacy)
    ".cds.unistra.fr",   # CDS (SIMBAD, VizieR, Aladin)
    ".gsfc.nasa.gov",    # heasarc, skyview
    ".eso.org",          # ESO archive
    ".noirlab.edu",      # NOIRLab data archive
]


def _parse_allowlist(raw: str | None) -> list[str]:
    if not raw:
        return list(DEFAULT_ALLOWED)
    items = [x.strip() for x in raw.split(",")]
    return [x.lower() for x in items if x]


ALLOWED_HOSTS: list[str] = _parse_allowlist(os.environ.get("ALLOWED_HOSTS"))
PROXY_PORT: int = int(os.environ.get("PROXY_PORT", "8080"))
TUNNEL_TIMEOUT_S: int = int(os.environ.get("TUNNEL_TIMEOUT_S", "120"))
MAX_UPSTREAM_CONNECT_S: int = int(os.environ.get("UPSTREAM_CONNECT_TIMEOUT_S", "15"))


def host_allowed(host: str, allowlist: Iterable[str] = ALLOWED_HOSTS) -> bool:
    """Return True if `host` matches the allowlist."""
    if not host:
        return False
    h = host.lower().split(":", 1)[0]  # strip port
    for rule in allowlist:
        if rule.startswith("."):
            if h == rule[1:] or h.endswith(rule):
                return True
        else:
            if h == rule:
                return True
    return False


# ── Logger (thread-safe single-line records) ────────────────────────────────

_log_lock = threading.Lock()


def _log(level: str, **fields) -> None:
    with _log_lock:
        parts = [f"ts={time.time():.3f}", f"level={level}"]
        parts.extend(f"{k}={v}" for k, v in fields.items())
        print(" ".join(parts), flush=True)


# ── HTTP handler ────────────────────────────────────────────────────────────


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GemixSandboxProxy/1.0"
    # Silence default noisy per-request log
    def log_message(self, format, *args):  # noqa: N802 (BaseHTTPRequestHandler API)
        return

    # ── CONNECT (HTTPS tunneling) ──────────────────────────────────────────
    def do_CONNECT(self) -> None:  # noqa: N802
        target = self.path  # "host:port"
        host, _, port_str = target.partition(":")
        try:
            port = int(port_str) if port_str else 443
        except ValueError:
            self._reject(400, "bad target")
            return

        if not host_allowed(host):
            _log("warn", event="deny_connect", host=host, port=port)
            self._reject(403, f"host {host} not allowed")
            return

        # Connect upstream
        try:
            upstream = socket.create_connection((host, port), timeout=MAX_UPSTREAM_CONNECT_S)
        except Exception as e:
            _log("warn", event="upstream_fail", host=host, port=port, err=str(e))
            self._reject(502, "upstream connect failed")
            return

        _log("info", event="allow_connect", host=host, port=port)
        try:
            self.send_response(200, "Connection Established")
            self.end_headers()
            self._pipe(self.connection, upstream)
        finally:
            try: upstream.close()
            except Exception: pass

    # ── Plain HTTP forwarding ──────────────────────────────────────────────
    def _forward_http(self) -> None:
        parsed = urlparse(self.path)
        host = parsed.hostname or self.headers.get("Host", "")
        port = parsed.port or 80
        if not host_allowed(host):
            _log("warn", event="deny_http", method=self.command, host=host)
            self._reject(403, f"host {host} not allowed")
            return

        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        # Build upstream request
        try:
            upstream = socket.create_connection((host, port), timeout=MAX_UPSTREAM_CONNECT_S)
        except Exception as e:
            _log("warn", event="upstream_fail", host=host, port=port, err=str(e))
            self._reject(502, "upstream connect failed")
            return

        content_length = int(self.headers.get("Content-Length", "0") or 0)
        body = self.rfile.read(content_length) if content_length else b""

        req_lines = [f"{self.command} {path} HTTP/1.1".encode()]
        # Overwrite connection headers we control; forward the rest
        skip = {"proxy-connection", "connection"}
        sent_host = False
        for k, v in self.headers.items():
            if k.lower() in skip:
                continue
            if k.lower() == "host":
                sent_host = True
            req_lines.append(f"{k}: {v}".encode())
        if not sent_host:
            req_lines.append(f"Host: {host}".encode())
        req_lines.append(b"Connection: close")
        req_data = b"\r\n".join(req_lines) + b"\r\n\r\n" + body

        try:
            upstream.sendall(req_data)
            _log("info", event="allow_http", method=self.command, host=host, body_bytes=len(body))
            self._pipe(upstream, self.connection, close_other=True)
        finally:
            try: upstream.close()
            except Exception: pass

    def do_GET(self):     self._forward_http()  # noqa: N802
    def do_POST(self):    self._forward_http()  # noqa: N802
    def do_PUT(self):     self._forward_http()  # noqa: N802
    def do_DELETE(self):  self._forward_http()  # noqa: N802
    def do_HEAD(self):    self._forward_http()  # noqa: N802
    def do_PATCH(self):   self._forward_http()  # noqa: N802
    def do_OPTIONS(self): self._forward_http()  # noqa: N802

    # ── Helpers ────────────────────────────────────────────────────────────
    def _reject(self, code: int, reason: str) -> None:
        body = f"{reason}\n".encode()
        try:
            self.send_response(code, reason)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass

    def _pipe(self, a: socket.socket, b: socket.socket, close_other: bool = False) -> None:
        """Bidirectional byte relay until one side closes or timeout expires."""
        a.settimeout(TUNNEL_TIMEOUT_S)
        b.settimeout(TUNNEL_TIMEOUT_S)

        def copy(src: socket.socket, dst: socket.socket) -> None:
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except Exception:
                pass
            finally:
                try: dst.shutdown(socket.SHUT_WR)
                except Exception: pass

        t1 = threading.Thread(target=copy, args=(a, b), daemon=True)
        t2 = threading.Thread(target=copy, args=(b, a), daemon=True)
        t1.start(); t2.start()
        t1.join(); t2.join()


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    _log(
        "info",
        event="startup",
        port=PROXY_PORT,
        allowlist=",".join(ALLOWED_HOSTS),
    )
    server = ThreadingHTTPServer(("0.0.0.0", PROXY_PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
