"""
GemiX sandbox egress proxy.

The ONLY bridge between the (internal, no-default-route) sandbox network and
the outside world. Every outbound HTTP(S) request from an agent workspace is
opened by this container, on its own bridge network, and never by the sandbox
itself. The host already sits on a residential connection, so no upstream
tunnel is involved: the value here is the chokepoint, not the exit IP.

Protocol support:
- HTTP CONNECT  (HTTPS tunneling) - by far the common case (requests, httpx, yt-dlp).
- Plain HTTP GET/POST/...           - forwarded verbatim.

Routing:
- Arbitrary public hosts are reachable, while loopback, private, link-local,
  reserved and otherwise non-global addresses are denied. The bot runs inside a
  home LAN, so that filter is what keeps model-authored code off the router and
  off every other device on 192.168.x.
- DNS is resolved and validated locally, and only the validated addresses are
  ever connected to, so rebinding cannot pivot the tunnel to a private host.
- Fail-closed: a destination that fails validation gets 403 and a destination
  that cannot be reached gets 502. There is no path out of the sandbox network
  that skips this check.

Operational:
- Listens on 0.0.0.0:${PROXY_PORT:-8080} (only reachable from the internal
  sandbox docker networks the manager attaches this container to).
- Structured log line per request: allow/deny/connect_fail, host, method, bytes.
- No per-client authentication - the internal docker network is the trust
  boundary. Do NOT expose this port to the host / internet.
"""

from __future__ import annotations

import errno
import json
import ipaddress
import os
import socket
import socketserver
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
CLIENT_REQUEST_TIMEOUT_S = 30
MAX_HTTP_REQUEST_BODY_BYTES = 8 * 1024 * 1024

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


# -- Destination policy and outbound connections ---------------------------


class PolicyError(ValueError):
    """The requested destination is outside the public internet boundary."""


def resolve_public_target(dst_host: str, dst_port: int) -> list[tuple[str, int]]:
    """
    Resolve a host and require every answer to be globally routable.

    Returns the validated `(address, family)` pairs, in resolver order. They are
    the only addresses the caller may connect to: the name is never handed to
    the socket layer again, so a second lookup cannot rebind it to a LAN host.
    """
    host = dst_host.strip().strip("[]").rstrip(".")
    if not host or host.lower() == "localhost" or host.lower().endswith(".localhost"):
        raise PolicyError("local destination denied")
    try:
        literal = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        literal = None
    if literal is not None:
        if not literal.is_global:
            raise PolicyError("non-public destination denied")
        family = socket.AF_INET6 if literal.version == 6 else socket.AF_INET
        return [(str(literal), family)]

    try:
        answers = socket.getaddrinfo(host, dst_port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise PolicyError(f"destination DNS lookup failed: {exc}") from exc
    addresses: list[tuple[str, int]] = []
    for family, _socktype, _proto, _canonname, sockaddr in answers:
        address = sockaddr[0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            raise PolicyError("destination DNS returned an invalid address") from exc
        if not ip.is_global:
            raise PolicyError("destination DNS returned a non-public address")
        pair = (str(ip), family)
        if pair not in addresses:
            addresses.append(pair)
    if not addresses:
        raise PolicyError("destination DNS returned no addresses")
    return addresses


# Errnos that mean this container has no usable way out, as opposed to one
# destination being down. Only these are worth waking the admin for; a refused
# or timed-out single host is ordinary and stays in the log.
_NO_EGRESS_ERRNOS = frozenset({errno.ENETUNREACH, errno.ENETDOWN, errno.EACCES, errno.EPERM})


def _is_egress_outage(exc: BaseException) -> bool:
    return isinstance(exc, OSError) and exc.errno in _NO_EGRESS_ERRNOS


def connect_public_target(
    addresses: list[tuple[str, int]], dst_port: int, timeout: int
) -> socket.socket:
    """
    Open a TCP connection to the first reachable address of an already validated
    destination. Returns a connected socket on success.

    Every address here came out of `resolve_public_target`, so trying the next
    one after a failure cannot widen the destination set - a dual-stack name
    whose IPv6 route is missing still resolves to its own IPv4 address.
    """
    last_exc: Exception | None = None
    for address, family in addresses:
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            sock.connect((address, dst_port))
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.settimeout(None)
            return sock
        except Exception as exc:
            last_exc = exc
            try:
                sock.close()
            except Exception:
                pass
    raise last_exc if last_exc is not None else OSError("no validated address to connect to")


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

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(CLIENT_REQUEST_TIMEOUT_S)

    # Silence default noisy per-request log
    def log_message(self, format, *args):  # noqa: N802 (BaseHTTPRequestHandler API)
        return

    # -- CONNECT (HTTPS tunneling) -----------------------------------------
    def do_CONNECT(self) -> None:  # noqa: N802
        target = self.path  # "host:port"
        try:
            parsed_target = urlparse(f"//{target}")
            host = parsed_target.hostname or ""
            port = parsed_target.port or 443
        except ValueError:
            self._reject(400, "bad target")
            return

        try:
            addresses = resolve_public_target(host, port)
        except PolicyError as e:
            _log("warn", event="deny_target", host=host, port=port, err=str(e))
            self._reject(403, "public internet destinations only")
            return
        try:
            upstream = connect_public_target(addresses, port, MAX_UPSTREAM_CONNECT_S)
        except Exception as e:
            _log("warn", event="connect_fail", host=host, port=port, err=str(e))
            if _is_egress_outage(e):
                _notify_admin(
                    "Proxy - no egress (CONNECT)",
                    f"Il container proxy non ha una via d'uscita di rete ({host}:{port}) - {e}",
                )
            self._reject(502, "destination unreachable")
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
        host_header = urlparse(f"//{self.headers.get('Host', '')}")
        host = parsed.hostname or host_header.hostname or ""
        try:
            port = parsed.port or host_header.port or 80
        except ValueError:
            self._reject(400, "bad target")
            return
        if not host:
            self._reject(400, "missing host")
            return

        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query

        try:
            addresses = resolve_public_target(host, port)
        except PolicyError as e:
            _log("warn", event="deny_target", host=host, port=port, err=str(e))
            self._reject(403, "public internet destinations only")
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            self._reject(400, "bad Content-Length")
            return
        if content_length < 0:
            self._reject(400, "bad Content-Length")
            return
        if content_length > MAX_HTTP_REQUEST_BODY_BYTES:
            self._reject(413, "request body too large")
            return
        try:
            body = self.rfile.read(content_length) if content_length else b""
        except (OSError, TimeoutError):
            self._reject(408, "request body timeout")
            return
        if len(body) != content_length:
            self._reject(400, "incomplete request body")
            return

        try:
            upstream = connect_public_target(addresses, port, MAX_UPSTREAM_CONNECT_S)
        except Exception as e:
            _log("warn", event="connect_fail", host=host, port=port, err=str(e))
            if _is_egress_outage(e):
                _notify_admin(
                    "Proxy - no egress (HTTP)",
                    f"Il container proxy non ha una via d'uscita di rete ({host}:{port}) - {e}",
                )
            self._reject(502, "destination unreachable")
            return

        req_lines = [f"{self.command} {path} HTTP/1.1".encode()]
        # Connection and Host are derived here, never trusted from the client.
        skip = {"proxy-connection", "connection", "host"}
        for k, v in self.headers.items():
            if k.lower() in skip:
                continue
            req_lines.append(f"{k}: {v}".encode())
        host_value = f"[{host}]" if ":" in host else host
        if port != 80:
            host_value = f"{host_value}:{port}"
        req_lines.append(f"Host: {host_value}".encode())
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
        self.close_connection = True
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
    _log("info", event="startup", port=PROXY_PORT, egress="direct")
    server = ThreadingHTTPServer(("0.0.0.0", PROXY_PORT), ProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
