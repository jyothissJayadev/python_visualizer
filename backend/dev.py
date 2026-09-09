"""backend/dev.py — run the backend and the Vite frontend together.

    python -m backend.dev --project D:\\code\\main\\atomics_system\\apps\\brain

Backend  -> http://127.0.0.1:8011
Frontend -> http://127.0.0.1:5177   (Vite dev server; proxies /viewer/* to
                                    the backend, HTTP + WebSocket)

Ctrl+C stops both. If either process exits, the other is shut down too.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"

DEFAULT_BACKEND_PORT = 8011
DEFAULT_FRONTEND_PORT = 5177


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="brain-terminal-dev",
        description="Run the Brain Terminal backend + Vite frontend together.",
    )
    parser.add_argument("--project", required=True, help="Path to the target Python project's root")
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT)
    parser.add_argument(
        "--ignore", action="append", default=[], metavar="DIR_NAME",
        help="Extra directory name to skip while scanning (repeatable)",
    )
    args = parser.parse_args(argv)

    if not (FRONTEND_DIR / "node_modules").is_dir():
        print("frontend/node_modules missing — run `cd frontend && npm install` first.", file=sys.stderr)
        return 1

    backend_cmd = [
        sys.executable, "-m", "backend.main",
        "--project", os.path.abspath(args.project),
        "--port", str(args.backend_port),
    ]
    for name in args.ignore:
        backend_cmd += ["--ignore", name]

    npm = "npm.cmd" if os.name == "nt" else "npm"
    frontend_cmd = [npm, "run", "dev", "--", "--port", str(args.frontend_port), "--strictPort"]

    env = dict(os.environ)
    env["BRAIN_TERMINAL_BACKEND_PORT"] = str(args.backend_port)

    print(f"  backend   -> http://127.0.0.1:{args.backend_port}")
    print(f"  frontend  -> http://127.0.0.1:{args.frontend_port}\n")

    procs: list[subprocess.Popen] = [
        subprocess.Popen(backend_cmd, cwd=ROOT),
        subprocess.Popen(frontend_cmd, cwd=FRONTEND_DIR, env=env),
    ]

    try:
        while True:
            for p in procs:
                if p.poll() is not None:
                    print(f"\n[dev] a process exited ({p.returncode}); shutting down.")
                    return p.returncode or 0
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("\n[dev] stopping…")
        return 0
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    raise SystemExit(main())
