"""
GemiX sandbox egress proxy.

The ONLY bridge between the (internal, no-default-route) sandbox network and
the outside world. Every outbound HTTP(S) request from a build sandbox is
forwarded upstream through a SOCKS5 proxy that exits on a residential IP
(tailsocks -> Tailscale -> Redmi phone, see SERVER_SETUP.md). This gives the
in-container `yt-dlp`/`curl`/`wget` the same residential egress that bypasses
datacenter anti-bot blocks.

Protocol support:
- HTTP CONNECT  (HTTPS tunneling) - by far the common case (requests, httpx, yt-dlp).
- Plain HTTP GET/POST/...           - forwarded verbatim.

Routing:
- There is NO host allowlist: any host is reachable, because the residential
  exit is the whole point and downloads target arbitrary CDNs/images.
- Upstream connections are made via SOCKS5 with remote DNS (socks5h semantics):
  the destination hostname is resolved on the Redmi side, never locally.
- Fail-closed: if the SOCKS5 upstream (Redmi) is unreachable, the request fails
  with 502 and there is no direct-internet fallback. When the Redmi is off, the
  sandbox simply has no internet (intended security property).

Operational:
- Listens on 0.0.0.0:${PROXY_PORT:-8080} (only reachable from the internal
  sandbox docker network).
- Reaches the SOCKS5 upstream at ${REDMI_SOCKS_HOST:-host.docker.internal}:
  ${REDMI_SOCKS_PORT:-5040}. On Linux, run the container with
  `--add-host=host.docker.internal:host-gateway` and make tailsocks listen on
  an address the container can reach (see SERVER_SETUP.md).
- Structured log line per request: allow/upstream_fail, host, method, bytes.
- No per-client authentication - the internal docker network is the trust
  boundary. Do NOT expose this port to the host / internet.
"""

from __future__ import annotations

import json
import os
import socket
import socketserver
import struct
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

# -- Configuration ---------------------------------------------------------

PROXY_PORT: int = int(os.environ.get("PROXY_PORT", "8080"))
TUNNEL_TIMEOUT_S: int = int(os.environ.get("TUNNEL_TIMEOUT_S", "120"))
MAX_UPSTREAM_CONNECT_S: int = int(os.environ.get("UPSTREAM_CONNECT_TIMEOUT_S", "15"))

# Residential SOCKS5 upstream (tailsocks -> Tailscale -> Redmi). All egress
# exits here; there is no direct-internet fallback.
REDMI_SOCKS_HOST: str = os.environ.get("REDMI_SOCKS_HOST", "host.docker.internal")
REDMI_SOCKS_PORT: int = int(os.environ.get("REDMI_SOCKS_PORT", "5040"))

GEMIX_NOTIFY_URL: str | None = os.environ.get(
    "GEMIX_NOTIFY_URL"
)  # e.g. http://host.docker.internal:9999/notify
GEMIX_NOTIFY_SECRET: str = os.environ.get("GEMIX_NOTIFY_SECRET", "")

# Per-source cooldown for admin notifications (avoid spam)
_notify_cooldowns: dict[str, float] = {}
_notify_lock = threading.Lock()
_NOTIFY_COOLDOWN_S = 300  # 5 minutes


def _notify_admin(source: str, details: str) -> None:
    """Send an error notification to the host's internal notify endpoint (non-blocking)."""
    if not GEMIX_NOTIFY_URL:
        return
    with _notify_lock:
        last = _notify_cooldowns.get(source, 0)
        if time.time() - last < _NOTIFY_COOLDOWN_S:
            return
        _notify_cooldowns[source] = time.time()

    def _post() -> None:
        try:
            payload = json.dumps({"source": source, "details": details}).encode()
            headers: dict[str, str] = {"Content-Type": "application/json"}
            if GEMIX_NOTIFY_SECRET:
                headers["X-Notify-Secret"] = GEMIX_NOTIFY_SECRET
            req = urllib.request.Request(
                GEMIX_NOTIFY_URL,
                data=payload,
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5):
                pass
        except Exception:
            pass  # never let notification errors surface

    threading.Thread(target=_post, daemon=True).start()


# -- SOCKS5 upstream client (no third-party deps) --------------------------


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise OSError("socks5 upstream closed early")
        buf += chunk
    return buf


def socks5_connect(dst_host: str, dst_port: int, timeout: int) -> socket.socket:
    """
    Open a tunnel to dst_host:dst_port through the SOCKS5 upstream (Redmi),
    resolving the destination hostname on the upstream side (socks5h). Returns a
    connected socket on success; raises OSError if the upstream or the target is
    unreachable.
    """
    sock = socket.create_connection(
        (REDMI_SOCKS_HOST, REDMI_SOCKS_PORT), timeout=timeout
    )
    try:
        sock.settimeout(timeout)
        # Greeting: VER=5, NMETHODS=1, METHOD=0 (no auth).
        sock.sendall(b"\x05\x01\x00")
        greeting = _recv_exact(sock, 2)
        if greeting[0] != 0x05 or greeting[1] != 0x00:
            raise OSError("socks5 upstream rejected no-auth handshake")

        try:
            host_bytes = dst_host.encode("idna")
        except Exception:
            host_bytes = dst_host.encode("ascii", "ignore")
        if not host_bytes or len(host_bytes) > 255:
            raise OSError(f"invalid destination host: {dst_host!r}")

        # CONNECT with domain ATYP (0x03) so the upstream resolves DNS.
        request = (
            b"\x05\x01\x00\x03"
            + bytes([len(host_bytes)])
            + host_bytes
            + struct.pack(">H", dst_port)
        )
        sock.sendall(request)

        reply = _recv_exact(sock, 4)
        if reply[0] != 0x05 or reply[1] != 0x00:
            raise OSError(f"socks5 CONNECT failed (reply code {reply[1]})")

        # Drain the bound address so the socket is positioned at the tunnel start.
        atyp = reply[3]
        if atyp == 0x01:  # IPv4
            _recv_exact(sock, 4 + 2)
        elif atyp == 0x03:  # domain
            dlen = _recv_exact(sock, 1)[0]
            _recv_exact(sock, dlen + 2)
        elif atyp == 0x04:  # IPv6
            _recv_exact(sock, 16 + 2)
        else:
            raise OSError(f"socks5 bad address type in reply ({atyp})")

        sock.settimeout(None)
        return sock
    except Exception:
        try:
            sock.close()
        except Exception:
            pass
        raise


# -- Logger (thread-safe single-line records) ------------------------------

_log_lock = threading.Lock()


def _log(level: str, **fields) -> None:
    with _log_lock:
        parts = [f"ts={time.time():.3f}", f"level={level}"]
        parts.extend(f"{k}={v}" for k, v in fields.items())
        print(" ".join(parts), flush=True)


# -- HTTP handler ----------------------------------------------------------


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GemixSandboxProxy/2.0"

    # Silence default noisy per-request log
    def log_message(self, format, *args):  # noqa: N802 (BaseHTTPRequestHandler API)
        return

    # -- CONNECT (HTTPS tunneling) -----------------------------------------
    def do_CONNECT(self) -> None:  # noqa: N802
        target = self.path  # "host:port"
        host, _, port_str = target.partition(":")
        try:
            port = int(port_str) if port_str else 443
        except ValueError:
            self._reject(400, "bad target")
            return

        try:
            upstream = socks5_connect(host, port, MAX_UPSTREAM_CONNECT_S)
        except Exception as e:
            _log("warn", event="upstream_fail", host=host, port=port, err=str(e))
            _notify_admin(
                "Proxy - upstream_fail (CONNECT)",
                f"Egress residenziale (Redmi) non raggiungibile per {host}:{port} - {e}",
            )
            self._reject(502, "residential upstream unavailable")
            return
        _log("info", event="allow_connect", host=host, port=port)
        try:
            self.send_response(200, "Connection Established")
            self.end_headers()
            self._pipe(self.connection, upstream)
        finally:
            try:
                upstream.close()
            except Exception:
                pass

    # -- Plain HTTP forwarding ---------------------------------------------
    def _forward_http(self) -> None:
        parsed = urlparse(self.path)
        host = parsed.hostname or self.headers.get("Host", "")
        port = parsed.port or 80
        if not host:
            self._reject(400, "missing host")
            return

        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        try:
            upstream = socks5_connect(host, port, MAX_UPSTREAM_CONNECT_S)
        except Exception as e:
            _log("warn", event="upstream_fail", host=host, port=port, err=str(e))
            _notify_admin(
                "Proxy - upstream_fail (HTTP)",
                f"Egress residenziale (Redmi) non raggiungibile per {host}:{port} - {e}",
            )
            self._reject(502, "residential upstream unavailable")
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
            _log(
                "info",
                event="allow_http",
                method=self.command,
                host=host,
                body_bytes=len(body),
            )
            self._pipe(upstream, self.connection, close_other=True)
        finally:
            try:
                upstream.close()
            except Exception:
                pass

    def do_GET(self):
        self._forward_http()  # noqa: N802

    def do_POST(self):
        self._forward_http()  # noqa: N802

    def do_PUT(self):
        self._forward_http()  # noqa: N802

    def do_DELETE(self):
        self._forward_http()  # noqa: N802

    def do_HEAD(self):
        self._forward_http()  # noqa: N802

    def do_PATCH(self):
        self._forward_http()  # noqa: N802

    def do_OPTIONS(self):
        self._forward_http()  # noqa: N802

    # -- Helpers -----------------------------------------------------------
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

    def _pipe(
        self, a: socket.socket, b: socket.socket, close_other: bool = False
    ) -> None:
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
                try:
                    dst.shutdown(socket.SHUT_WR)
                except Exception:
                    pass

        t1 = threading.Thread(target=copy, args=(a, b), daemon=True)
        t2 = threading.Thread(target=copy, args=(b, a), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()


class ThreadingHTTPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    _log(
        "info",
        event="startup",
        port=PROXY_PORT,
        upstream=f"socks5h://{REDMI_SOCKS_HOST}:{REDMI_SOCKS_PORT}",
    )
    server = ThreadingHTTPServer(("0.0.0.0", PROXY_PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
