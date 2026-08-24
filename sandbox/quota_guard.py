"""Keep a sandbox workspace within its aggregate byte budget.

This process is PID 1 in each workspace container. It watches the bind-mounted
tree for writes made by foreground or background commands and kills sandbox
processes when the tree crosses the configured limit. Once the user removes
enough data, monitoring arms again.
"""

from __future__ import annotations

import os
import signal
import sys
import time


WORKSPACE = "/workspace"
POLL_SECONDS = 0.1


def _tree_size(root: str) -> int:
    total = 0
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            entries = os.scandir(current)
        except OSError:
            continue
        with entries:
            for entry in entries:
                try:
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        pending.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    return total


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


def _should_kill_jobs(size: int, limit: int, previous_size: int, was_over: bool) -> bool:
    """Stop the crossing writer, including the first command after an old overflow."""
    return size > limit and (not was_over or size > previous_size)


def main() -> int:
    try:
        limit = int(sys.argv[1])
    except (IndexError, ValueError):
        print("quota_guard: byte limit argument required", file=sys.stderr, flush=True)
        return 2
    if limit <= 0:
        print("quota_guard: byte limit must be positive", file=sys.stderr, flush=True)
        return 2

    signal.signal(signal.SIGCHLD, _reap_children)
    over_limit = False
    previous_size = 0
    while True:
        size = _tree_size(WORKSPACE)
        if _should_kill_jobs(size, limit, previous_size, over_limit):
            print(
                f"quota_guard: workspace crossed limit ({size} > {limit}); killing sandbox jobs",
                file=sys.stderr,
                flush=True,
            )
            _kill_sandbox_processes()
        over_limit = size > limit
        previous_size = size
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
