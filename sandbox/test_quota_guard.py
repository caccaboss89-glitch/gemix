from __future__ import annotations

import os
import tempfile
import unittest

from quota_guard import (
    POLL_MAX_SECONDS,
    POLL_MIN_SECONDS,
    _parse_roots,
    _poll_seconds,
    _should_kill_jobs,
    _tree_inventory,
    _tree_size,
)


class QuotaGuardTests(unittest.TestCase):
    def test_roots_parse_as_absolute_path_and_positive_limit_pairs(self) -> None:
        self.assertEqual(
            _parse_roots(["/workspace=10:20", "/skills=5:7"]),
            [("/workspace", 10, 20), ("/skills", 5, 7)],
        )

    def test_malformed_or_missing_roots_are_refused(self) -> None:
        for args in (
            [], ["/workspace"], ["workspace=10:20"], ["/workspace=0:20"],
            ["/workspace=10:0"], ["/workspace=x:20"], ["/workspace=10"],
        ):
            self.assertIsNone(_parse_roots(args), args)

    def test_overflow_kills_on_entry_and_on_further_growth(self) -> None:
        self.assertTrue(_should_kill_jobs(11, 10, 0, False))
        self.assertFalse(_should_kill_jobs(11, 10, 11, True))
        self.assertTrue(_should_kill_jobs(12, 10, 11, True))
        self.assertFalse(_should_kill_jobs(9, 10, 12, True))

    def test_poll_interval_tracks_the_headroom_it_is_watching(self) -> None:
        # Room to spare: walking ten times a second buys nothing.
        self.assertEqual(_poll_seconds(10 * 1024**3), POLL_MAX_SECONDS)
        # Close to the limit, and at the limit or past it, react at full rate.
        self.assertEqual(_poll_seconds(0), POLL_MIN_SECONDS)
        self.assertEqual(_poll_seconds(-1024), POLL_MIN_SECONDS)
        # In between the interval is the time that headroom survives a writer
        # going flat out, so it rises with the room left.
        middle = _poll_seconds(256 * 1024**2)
        self.assertGreater(middle, POLL_MIN_SECONDS)
        self.assertLess(middle, POLL_MAX_SECONDS)
        self.assertLess(middle, _poll_seconds(512 * 1024**2))

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

    def test_tree_inventory_stops_at_the_entry_budget(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            for index in range(3):
                with open(os.path.join(root, f"{index}.txt"), "wb") as handle:
                    handle.write(b"x")
            size, entries, complete = _tree_inventory(root, 2)
            self.assertFalse(complete)
            self.assertEqual(entries, 3)
            self.assertLessEqual(size, 2)


if __name__ == "__main__":
    unittest.main()
