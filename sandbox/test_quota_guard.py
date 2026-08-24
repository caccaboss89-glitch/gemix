from __future__ import annotations

import os
import tempfile
import unittest

from quota_guard import _should_kill_jobs, _tree_size


class QuotaGuardTests(unittest.TestCase):
    def test_overflow_kills_on_entry_and_on_further_growth(self) -> None:
        self.assertTrue(_should_kill_jobs(11, 10, 0, False))
        self.assertFalse(_should_kill_jobs(11, 10, 11, True))
        self.assertTrue(_should_kill_jobs(12, 10, 11, True))
        self.assertFalse(_should_kill_jobs(9, 10, 12, True))

    def test_tree_size_counts_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            with open(os.path.join(root, "inside.bin"), "wb") as handle:
                handle.write(b"inside")
            self.assertEqual(_tree_size(root), len(b"inside"))

    def test_tree_size_does_not_follow_links(self) -> None:
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            with open(os.path.join(root, "inside.bin"), "wb") as handle:
                handle.write(b"inside")
            with open(os.path.join(outside, "outside.bin"), "wb") as handle:
                handle.write(b"outside-secret")
            try:
                os.symlink(outside, os.path.join(root, "escape"), target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("symlinks unavailable")
            self.assertEqual(_tree_size(root), len(b"inside"))


if __name__ == "__main__":
    unittest.main()
