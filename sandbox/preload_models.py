"""
Preload heavy models so the first code_execution call is fast and
so the sandbox is fully offline-ready (no download at runtime).

Executed once at Docker build time.
"""

import os
import sys


def preload_rembg() -> None:
    try:
        import rembg  # type: ignore
    except ImportError as e:
        print(f"[preload] rembg not installed: {e}", file=sys.stderr)
        return
    # u2net is the default, highest-quality general-purpose matting model.
    print("[preload] downloading rembg u2net model...", flush=True)
    rembg.new_session("u2net")
    # Optional: also grab the lighter variant for faster inference on small images.
    try:
        rembg.new_session("u2netp")
    except Exception as e:  # pragma: no cover - best-effort
        print(f"[preload] u2netp not available: {e}", file=sys.stderr)
    print("[preload] rembg ready.", flush=True)


def preload_matplotlib_font_cache() -> None:
    try:
        import matplotlib  # type: ignore
        import matplotlib.pyplot as plt  # noqa: F401

        matplotlib.get_cachedir()
        # Force font cache build
        from matplotlib import font_manager  # type: ignore

        font_manager.findSystemFonts()
        print("[preload] matplotlib font cache built.", flush=True)
    except Exception as e:
        print(f"[preload] matplotlib preload skipped: {e}", file=sys.stderr)


def main() -> int:
    print(f"[preload] python: {sys.version}", flush=True)
    print(f"[preload] HOME={os.environ.get('HOME')}", flush=True)
    preload_rembg()
    preload_matplotlib_font_cache()
    return 0


if __name__ == "__main__":
    sys.exit(main())
