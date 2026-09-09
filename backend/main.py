"""backend/main.py — CLI entrypoint.

    python -m backend.main --project ./my_backend [--host 127.0.0.1] [--port 8765]

Binds to 127.0.0.1 by default — this is an unauthenticated localhost dev
tool that proxies to the target ("brain") server; never expose it further.
"""

from __future__ import annotations

import argparse
import os

import uvicorn

from backend.app import create_app
from backend.config import DEFAULT_IGNORED_DIRECTORIES, ExplorerConfig


def parse_args(argv: list[str] | None = None) -> ExplorerConfig:
    parser = argparse.ArgumentParser(prog="brain-terminal", description="Brain Terminal — live trace & function I/O inspector")
    parser.add_argument("--project", required=True, help="Path to the target Python project's root directory")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1, localhost only)")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--ignore",
        action="append",
        default=[],
        metavar="DIR_NAME",
        help="Additional directory name to ignore while scanning (repeatable)",
    )
    args = parser.parse_args(argv)

    ignored = frozenset(DEFAULT_IGNORED_DIRECTORIES | set(args.ignore))
    return ExplorerConfig(
        project_path=os.path.abspath(args.project),
        host=args.host,
        port=args.port,
        ignored_directories=ignored,
    )


def main(argv: list[str] | None = None) -> None:
    config = parse_args(argv)
    app = create_app(config)
    uvicorn.run(app, host=config.host, port=config.port)


if __name__ == "__main__":
    main()
