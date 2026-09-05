"""Keep each writable sandbox root within its aggregate byte budget.

This process is PID 1 in each workspace container. It watches the bind-mounted
trees for writes made by foreground or background commands and kills sandbox
processes when one of them crosses its configured limit. Once the user removes
enough data, monitoring arms again for that root.

Roots are given as `<path>=<bytes>:<entries>` arguments, one per writable
mount, e.g. `/workspace=10737418240:100000`.

Watching costs one full walk of each tree, whose price is the number of files
in it rather than their size, so the interval tracks the risk instead of being
fixed: it stretches while a root sits far below its limit and tightens as one
approaches it.
"""

from __future__ import annotations

import os
import signal
import sys
import time


POLL_MIN_SECONDS = 0.1
POLL_MAX_SECONDS = 5.0
# Bytes per second a runaway writer is assumed not to beat. The interval is how
# long the tightest headroom would survive at this rate, so crossing a limit
# unnoticed takes a writer faster than any disk the sandbox runs on.
ASSUMED_WRITE_RATE = 200 * 1024 * 1024


def _poll_seconds(headroom: int) -> float:
    """How long the tightest headroom can be left unwatched, in seconds."""
    return max(POLL_MIN_SECONDS, min(POLL_MAX_SECONDS, headroom / ASSUMED_WRITE_RATE))


def _tree_inventory(root: str, max_entries: int) -> tuple[int, int, bool]:
    total = 0
    entry_count = 0
    complete = True
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = os.scandir(current)
        except OSError:
            complete = False
            continue
        with entries:
            for entry in entries:
                entry_count += 1
                if entry_count > max_entries:
                    return total, entry_count, False
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    complete = False
                    continue
    return total, entry_count, complete


def _tree_size(root: str) -> int:
    return _tree_inventory(root, sys.maxsize)[0]


def _kill_sandbox_processes() -> None:
    own_uid = os.getuid()
    for raw_pid in os.listdir("/proc"):
        if not raw_pid.isdigit() or raw_pid == "1":
            continue
        try:
            stat = os.stat(f"/proc/{raw_pid}")
            if stat.st_uid == own_uid:
                os.kill(int(raw_pid), signal.SIGKILL)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue


def _reap_children(_signum: int, _frame: object) -> None:
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def _parse_roots(args: list[str]) -> list[tuple[str, int, int]] | None:
    """Turn `<path>=<bytes>:<entries>` arguments into triples."""
    roots: list[tuple[str, int, int]] = []
    for raw in args:
        path, separator, raw_limits = raw.partition("=")
        if not separator or not path.startswith("/"):
            return None
        byte_limit, entry_separator, entry_limit = raw_limits.partition(":")
        if not entry_separator:
            return None
        try:
            byte_value = int(byte_limit)
            entry_value = int(entry_limit)
        except ValueError:
            return None
        if byte_value <= 0 or entry_value <= 0:
            return None
        roots.append((path, byte_value, entry_value))
    return roots or None


def _should_kill_jobs(size: int, limit: int, previous_size: int, was_over: bool) -> bool:
    """Stop the crossing writer, including the first command after an old overflow."""
    return size > limit and (not was_over or size > previous_size)


def main() -> int:
    roots = _parse_roots(sys.argv[1:])
    if roots is None:
        print(
            "quota_guard: at least one <absolute-path>=<positive-byte-limit>:<positive-entry-limit> argument required",
            file=sys.stderr,
            flush=True,
        )
        return 2

    signal.signal(signal.SIGCHLD, _reap_children)
    over_limit = {path: False for path, _, _ in roots}
    previous_size = {path: 0 for path, _, _ in roots}
    previous_entries = {path: 0 for path, _, _ in roots}
    while True:
        headrooms = []
        for path, byte_limit, entry_limit in roots:
            size, entries, complete = _tree_inventory(path, entry_limit)
            violated = not complete or size > byte_limit or entries > entry_limit
            grew_while_violated = size > previous_size[path] or entries > previous_entries[path]
            if violated and (not over_limit[path] or grew_while_violated):
                print(
                    f"quota_guard: {path} inventory violated a limit "
                    f"(bytes={size}/{byte_limit}, entries={entries}/{entry_limit}, complete={complete}); "
                    "killing sandbox jobs",
                    file=sys.stderr,
                    flush=True,
                )
                _kill_sandbox_processes()
            over_limit[path] = violated
            previous_size[path] = size
            previous_entries[path] = entries
            # Convert entry headroom to a conservative byte-like scale for the
            # existing adaptive poll function; this avoids a 10 Hz full walk
            # merely because the unit is a count.
            entry_headroom_scale = (entry_limit - entries) * 4096
            headrooms.append(min(byte_limit - size, entry_headroom_scale))
        time.sleep(_poll_seconds(min(headrooms)))


if __name__ == "__main__":
    raise SystemExit(main())
