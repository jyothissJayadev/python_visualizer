"""backend/main.py — CLI entrypoint.

    python -m backend.main --project ./my_backend [--host 127.0.0.1] [--port 8765]

Binds to 127.0.0.1 by default (§3) — this runs arbitrary code from the
target project on request, so it must never be exposed beyond localhost by
default.
"""

from __future__ import annotations

import argparse
import os

import uvicorn

from backend.app import create_app
from backend.config import DEFAULT_IGNORED_DIRECTORIES, ExplorerConfig


def parse_args(argv: list[str] | None = None) -> ExplorerConfig:
    parser = argparse.ArgumentParser(prog="python-explorer", description="Python Backend Explorer")
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
    parser.add_argument(
        "--working-directory",
        default=None,
        help="cwd to run the target project's code from (default: --project)",
    )
    parser.add_argument(
        "--startup-hook",
        default=None,
        metavar="module.path:function_name",
        help="Async or sync function to run once before the first execution "
        "(e.g. to register ODM document models normally set up by the target's own startup code)",
    )
    parser.add_argument(
        "--host-app",
        default=None,
        metavar="module.path:attr",
        help="Import the target's own ASGI app (e.g. 'app.main:app') and mount it, tracing "
        "every request: the call tree of the target's functions with arguments and return values",
    )
    parser.add_argument(
        "--host-app-mount",
        default="/app",
        help='URL prefix to mount --host-app under (default: /app). Use "" or "/" for drop-in '
        "mode: the target answers on its own unprefixed paths, so callers only change the port",
    )
    parser.add_argument(
        "--internal-key",
        default=None,
        metavar="KEY",
        help="Value injected as the internal-service header on every proxied request to --host-app "
        "(so callers don't need the target's shared secret)",
    )
    parser.add_argument(
        "--internal-key-header",
        default="x-internal-api-key",
        help="Header name for --internal-key (default: x-internal-api-key)",
    )
    parser.add_argument(
        "--trace-root",
        default=None,
        metavar="PATH",
        help="Only record calls in files under this directory (default: <project>/app if it exists, else <project>)",
    )
    parser.add_argument("--max-traces", type=int, default=50, help="Recent traces to keep (default: 50)")
    parser.add_argument(
        "--max-trace-calls", type=int, default=20000, help="Cap on recorded calls per trace (default: 20000)"
    )
    parser.add_argument("--max-trace-depth", type=int, default=60, help="Cap on call depth per trace (default: 60)")
    args = parser.parse_args(argv)

    ignored = frozenset(DEFAULT_IGNORED_DIRECTORIES | set(args.ignore))
    return ExplorerConfig(
        project_path=os.path.abspath(args.project),
        host=args.host,
        port=args.port,
        ignored_directories=ignored,
        working_directory=args.working_directory,
        startup_hook=args.startup_hook,
        host_app=args.host_app,
        host_app_mount=args.host_app_mount,
        internal_api_key=args.internal_key,
        internal_api_key_header=args.internal_key_header,
        trace_root=args.trace_root,
        max_traces=args.max_traces,
        max_trace_calls=args.max_trace_calls,
        max_trace_depth=args.max_trace_depth,
    )


def main(argv: list[str] | None = None) -> None:
    config = parse_args(argv)
    app = create_app(config)
    uvicorn.run(app, host=config.host, port=config.port)


if __name__ == "__main__":
    main()
