from __future__ import annotations

import errno
import socket
import unittest
from unittest.mock import patch

from proxy import PolicyError, _is_egress_outage, resolve_public_target


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


if __name__ == "__main__":
    unittest.main()
