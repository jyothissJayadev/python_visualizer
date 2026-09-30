"""backend/main.py — CLI entrypoint.

    python -m backend.main --project ./my_backend [--host 127.0.0.1] [--port 8765]

Binds to 127.0.0.1 by default — this is an unauthenticated localhost dev
tool that proxies to the target ("brain") server; never expose it further.
"""

from __future__ import annotations

import argparse
import os

import uvicorn

from backend.config import ALL_FEATURES, DEFAULT_IGNORED_DIRECTORIES, ExplorerConfig, project_path_problem


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
    parser.add_argument("--name", default="default", help="Instance name shown in the dashboard")
    parser.add_argument(
        "--features",
        default=",".join(ALL_FEATURES),
        help=f"Comma-separated dashboard features to enable (default: all of {', '.join(ALL_FEATURES)})",
    )
    args = parser.parse_args(argv)
    features = tuple(f for f in args.features.split(",") if f)
    bad = [f for f in features if f not in ALL_FEATURES]
    if bad or "terminal" not in features:
        parser.error(f"--features must include 'terminal' and only use {list(ALL_FEATURES)}; got {args.features!r}")
    problem = project_path_problem(os.path.abspath(args.project))
    if problem:
        parser.error(problem)

    ignored = frozenset(DEFAULT_IGNORED_DIRECTORIES | set(args.ignore))
    return ExplorerConfig(
        project_path=os.path.abspath(args.project),
        host=args.host,
        port=args.port,
        ignored_directories=ignored,
        name=args.name,
        features=features,
    )


def main(argv: list[str] | None = None) -> None:
    config = parse_args(argv)
    # Hand the config to the app factory (backend.app:make_app) via env so
    # uvicorn can own an import string and hot-reload on backend edits.
    os.environ["BRAIN_TERMINAL_PROJECT"] = config.project_path
    os.environ["BRAIN_TERMINAL_HOST"] = config.host
    os.environ["BRAIN_TERMINAL_PORT"] = str(config.port)
    os.environ["VIZ_INSTANCE_NAME"] = config.name
    os.environ["VIZ_FEATURES"] = ",".join(config.features)
    os.environ["BRAIN_TERMINAL_IGNORE"] = os.pathsep.join(
        sorted(config.ignored_directories - DEFAULT_IGNORED_DIRECTORIES)
    )
    uvicorn.run(
        "backend.app:make_app",
        factory=True,
        host=config.host,
        port=config.port,
        reload=True,
        reload_dirs=[os.path.dirname(__file__)],
    )


if __name__ == "__main__":
    main()
