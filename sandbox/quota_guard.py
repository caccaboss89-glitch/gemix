"""Keep each writable sandbox root within its aggregate byte budget.

This process is PID 1 in each workspace container. It watches the bind-mounted
trees for writes made by foreground or background commands and kills sandbox
processes when one of them crosses its configured limit. Once the user removes
enough data, monitoring arms again for that root.

Roots are given as `<path>=<bytes>` arguments, one per writable mount, e.g.
`/workspace=2147483648 /skills=104857600`.
"""

from __future__ import annotations

import os
import signal
import sys
import time


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


def _parse_roots(args: list[str]) -> list[tuple[str, int]] | None:
    """Turn `<path>=<bytes>` arguments into pairs, or None if any is malformed."""
    roots: list[tuple[str, int]] = []
    for raw in args:
        path, separator, limit = raw.partition("=")
        if not separator or not path.startswith("/"):
            return None
        try:
            value = int(limit)
        except ValueError:
            return None
        if value <= 0:
            return None
        roots.append((path, value))
    return roots or None


def _should_kill_jobs(size: int, limit: int, previous_size: int, was_over: bool) -> bool:
    """Stop the crossing writer, including the first command after an old overflow."""
    return size > limit and (not was_over or size > previous_size)


def main() -> int:
    roots = _parse_roots(sys.argv[1:])
    if roots is None:
        print(
            "quota_guard: at least one <absolute-path>=<positive-byte-limit> argument required",
            file=sys.stderr,
            flush=True,
        )
        return 2

    signal.signal(signal.SIGCHLD, _reap_children)
    over_limit = {path: False for path, _ in roots}
    previous_size = {path: 0 for path, _ in roots}
    while True:
        for path, limit in roots:
            size = _tree_size(path)
            if _should_kill_jobs(size, limit, previous_size[path], over_limit[path]):
                print(
                    f"quota_guard: {path} crossed limit ({size} > {limit}); killing sandbox jobs",
                    file=sys.stderr,
                    flush=True,
                )
                _kill_sandbox_processes()
            over_limit[path] = size > limit
            previous_size[path] = size
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
