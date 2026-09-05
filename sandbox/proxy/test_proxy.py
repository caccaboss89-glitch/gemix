from __future__ import annotations

import errno
import io
import socket
import threading
import unittest
from email.message import Message
from unittest.mock import MagicMock, patch

from proxy import (
    PolicyError,
    ProxyHandler,
    _connection_tokens,
    _is_egress_outage,
    _unsupported_transfer_encoding,
    resolve_public_target,
)


class PublicTargetPolicyTests(unittest.TestCase):
    def test_private_literals_are_denied(self) -> None:
        # 192.168.x is the home LAN GemiX now runs inside and 172.17.0.1 the
        # docker host gateway: both are what the sandbox must never reach.
        for host in (
            "127.0.0.1",
            "10.0.0.1",
            "169.254.1.1",
            "192.168.1.1",
            "172.17.0.1",
            "::1",
            "fc00::1",
        ):
            with self.subTest(host=host), self.assertRaises(PolicyError):
                resolve_public_target(host, 443)

    @patch("proxy.socket.getaddrinfo")
    def test_one_private_dns_answer_denies_the_whole_name(self, lookup) -> None:
        lookup.return_value = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443)),
        ]
        with self.assertRaises(PolicyError):
            resolve_public_target("example.test", 443)

    @patch("proxy.socket.getaddrinfo")
    def test_public_dns_answer_is_pinned_as_an_ip(self, lookup) -> None:
        lookup.return_value = [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
        ]
        self.assertEqual(
            resolve_public_target("example.test", 443), [("8.8.8.8", socket.AF_INET)]
        )

    @patch("proxy.socket.getaddrinfo")
    def test_every_public_answer_is_kept_once_in_resolver_order(self, lookup) -> None:
        lookup.return_value = [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:4860:4860::8888", 443, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
        ]
        self.assertEqual(
            resolve_public_target("example.test", 443),
            [("2001:4860:4860::8888", socket.AF_INET6), ("8.8.8.8", socket.AF_INET)],
        )


class EgressOutageTests(unittest.TestCase):
    def test_only_container_level_failures_are_outages(self) -> None:
        self.assertTrue(_is_egress_outage(OSError(errno.ENETUNREACH, "unreachable")))
        self.assertFalse(_is_egress_outage(OSError(errno.ECONNREFUSED, "refused")))
        self.assertFalse(_is_egress_outage(TimeoutError("timed out")))


class ForwardingProtocolTests(unittest.TestCase):
    def test_connection_header_names_are_case_insensitive_tokens(self) -> None:
        self.assertEqual(
            _connection_tokens("keep-alive, X-Trace,  x-trace"),
            {"keep-alive", "x-trace"},
        )

    def test_transfer_encoding_is_rejected_except_identity(self) -> None:
        self.assertTrue(_unsupported_transfer_encoding("chunked"))
        self.assertTrue(_unsupported_transfer_encoding("gzip, chunked"))
        self.assertFalse(_unsupported_transfer_encoding(""))
        self.assertFalse(_unsupported_transfer_encoding(" identity "))

    @staticmethod
    def _handler(headers: dict[str, str], body: bytes = b""):
        class Handler:
            path = "http://example.test/upload?part=1"
            command = "POST"
            connection = object()

            def __init__(self) -> None:
                self.headers = Message()
                for key, value in headers.items():
                    self.headers[key] = value
                self.rfile = io.BytesIO(body)
                self.rejected = None

            def _reject(self, code: int, reason: str) -> None:
                self.rejected = (code, reason)

            def _pipe(self, _upstream, _client) -> None:
                pass

        return Handler()

    @patch("proxy.connect_public_target")
    @patch("proxy.resolve_public_target")
    def test_plain_http_rebuilds_framing_and_strips_dynamic_hop_headers(
        self, resolve, connect
    ) -> None:
        resolve.return_value = [("8.8.8.8", socket.AF_INET)]
        upstream = MagicMock()
        connect.return_value = upstream
        handler = self._handler(
            {
                "Host": "example.test",
                "Content-Length": "4",
                "Connection": "keep-alive, X-Internal",
                "X-Internal": "must-not-leak",
                "Keep-Alive": "timeout=5",
                "Transfer-Encoding": "identity",
                "X-End-To-End": "kept",
            },
            b"body",
        )

        ProxyHandler._forward_http(handler)

        self.assertIsNone(handler.rejected)
        request = upstream.sendall.call_args.args[0]
        self.assertIn(b"POST /upload?part=1 HTTP/1.1\r\n", request)
        self.assertIn(b"Host: example.test\r\n", request)
        self.assertIn(b"Content-Length: 4\r\n", request)
        self.assertIn(b"Connection: close\r\n", request)
        self.assertIn(b"X-End-To-End: kept\r\n", request)
        self.assertNotIn(b"X-Internal", request)
        self.assertNotIn(b"Keep-Alive", request)
        self.assertNotIn(b"Transfer-Encoding", request)
        self.assertTrue(request.endswith(b"\r\n\r\nbody"))

    @patch("proxy.connect_public_target")
    @patch("proxy.resolve_public_target")
    def test_chunked_request_is_rejected_before_resolution_or_connect(
        self, resolve, connect
    ) -> None:
        handler = self._handler(
            {"Host": "example.test", "Transfer-Encoding": "chunked"}
        )

        ProxyHandler._forward_http(handler)

        self.assertEqual(handler.rejected[0], 501)
        resolve.assert_not_called()
        connect.assert_not_called()

    def test_client_half_close_does_not_truncate_the_upstream_response(self) -> None:
        client, relay_client = socket.socketpair()
        relay_upstream, upstream = socket.socketpair()
        worker = threading.Thread(
            target=ProxyHandler._pipe,
            args=(None, relay_client, relay_upstream),
            daemon=True,
        )
        worker.start()
        try:
            client.sendall(b"request")
            client.shutdown(socket.SHUT_WR)
            self.assertEqual(upstream.recv(7), b"request")
            self.assertEqual(upstream.recv(1), b"")

            upstream.sendall(b"complete response")
            upstream.shutdown(socket.SHUT_WR)
            received = bytearray()
            while True:
                chunk = client.recv(1024)
                if not chunk:
                    break
                received.extend(chunk)
            self.assertEqual(bytes(received), b"complete response")
            worker.join(timeout=1)
            self.assertFalse(worker.is_alive())
        finally:
            for sock in (client, relay_client, relay_upstream, upstream):
                sock.close()

    def test_malformed_http_authority_is_rejected_without_a_handler_exception(self) -> None:
        handler = self._handler({"Host": "[invalid"})
        ProxyHandler._forward_http(handler)
        self.assertEqual(handler.rejected[0], 400)


if __name__ == "__main__":
    unittest.main()
