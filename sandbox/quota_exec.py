"""Apply a per-file ceiling before executing a sandbox command."""

from __future__ import annotations

import os
import resource
import sys


def main() -> int:
    try:
        limit = int(sys.argv[1])
    except (IndexError, ValueError):
        print("quota_exec: byte limit argument required", file=sys.stderr)
        return 2
    command = sys.argv[2:]
    if limit <= 0 or not command:
        print("quota_exec: positive limit and command required", file=sys.stderr)
        return 2
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))
    os.execvp(command[0], command)
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
