from __future__ import annotations

import socket
import unittest
from unittest.mock import patch

from proxy import PolicyError, resolve_public_target


class PublicTargetPolicyTests(unittest.TestCase):
    def test_private_literals_are_denied(self) -> None:
        for host in ("127.0.0.1", "10.0.0.1", "169.254.1.1", "::1", "fc00::1"):
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
        self.assertEqual(resolve_public_target("example.test", 443), ("8.8.8.8", socket.AF_INET))


if __name__ == "__main__":
    unittest.main()
