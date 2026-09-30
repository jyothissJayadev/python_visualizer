"""backend/dev.py — run one or more visualizer instances (backend + Vite frontend each).

    python -m backend.dev --list
    python -m backend.dev --instance arthur              # a named instance from instances.json
    python -m backend.dev --instance atomics --instance arthur
    python -m backend.dev --all
    python -m backend.dev --project /path/to/backend      # ad-hoc, as before

Each instance gets its own backend port (collector) and frontend port; the target backend
reports to its instance with the env shown at start-up. Ctrl+C stops everything; if any
process exits, the rest are shut down too.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

from backend.config import project_path_problem
from backend.instances import DEFAULT_INSTANCES_FILE, Instance, InstanceError, load_instances

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"

DEFAULT_BACKEND_PORT = 8011
DEFAULT_FRONTEND_PORT = 5177


def backend_command(inst: Instance) -> list[str]:
    cmd = [
        sys.executable, "-m", "backend.main",
        "--project", inst.project,
        "--port", str(inst.backend_port),
        "--name", inst.name,
        "--features", ",".join(inst.features),
    ]
    for name in inst.ignore:
        cmd += ["--ignore", name]
    return cmd


def frontend_command(inst: Instance) -> list[str]:
    npm = "npm.cmd" if os.name == "nt" else "npm"
    return [npm, "run", "dev", "--", "--port", str(inst.frontend_port), "--strictPort"]


def frontend_env(inst: Instance) -> dict[str, str]:
    env = dict(os.environ)
    env["BRAIN_TERMINAL_BACKEND_PORT"] = str(inst.backend_port)
    env["VIZ_FRONTEND_PORT"] = str(inst.frontend_port)
    return env


def describe(inst: Instance) -> str:
    lines = [
        f"  [{inst.name}] {inst.project}",
        f"      backend   -> http://127.0.0.1:{inst.backend_port}",
        f"      frontend  -> http://127.0.0.1:{inst.frontend_port}   features: {', '.join(inst.features)}",
        "      target env: " + " ".join(f"{k}={v}" for k, v in inst.env_for_target().items() if v),
    ]
    return "\n".join(lines)


def resolve(args: argparse.Namespace, parser: argparse.ArgumentParser) -> list[Instance]:
    if args.project:
        if args.instance or args.all:
            parser.error("--project cannot be combined with --instance/--all")
        return [Instance(
            name="default", project=os.path.abspath(args.project),
            backend_port=args.backend_port, frontend_port=args.frontend_port, ignore=tuple(args.ignore),
        )]
    try:
        known = load_instances(args.instances_file)
    except InstanceError as exc:
        parser.error(str(exc))
    if args.list:
        return list(known.values())
    names = list(known) if args.all else args.instance
    if not names:
        parser.error("choose --instance NAME (repeatable), --all, --list, or --project PATH")
    missing = [n for n in names if n not in known]
    if missing:
        parser.error(f"unknown instance(s) {missing}; known: {list(known)}")
    return [known[n] for n in dict.fromkeys(names)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="brain-terminal-dev",
        description="Run visualizer instance(s): backend + Vite frontend each.",
    )
    parser.add_argument("--instance", action="append", default=[], metavar="NAME", help="Instance from instances.json (repeatable)")
    parser.add_argument("--all", action="store_true", help="Run every instance in instances.json")
    parser.add_argument("--list", action="store_true", help="List the configured instances and exit")
    parser.add_argument("--instances-file", default=str(DEFAULT_INSTANCES_FILE))
    parser.add_argument("--project", help="Ad-hoc single target (skips instances.json)")
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT)
    parser.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT)
    parser.add_argument(
        "--ignore", action="append", default=[], metavar="DIR_NAME",
        help="Extra directory name to skip while scanning (ad-hoc --project only)",
    )
    args = parser.parse_args(argv)
    instances = resolve(args, parser)

    if args.list:
        print("\n".join(describe(i) for i in instances))
        return 0
    for inst in instances:
        problem = project_path_problem(inst.project)
        if problem:
            parser.error(f"[{inst.name}] {problem}")
    if not (FRONTEND_DIR / "node_modules").is_dir():
        print("frontend/node_modules missing — run `cd frontend && npm install` first.", file=sys.stderr)
        return 1

    print("\n".join(describe(i) for i in instances) + "\n")
    procs: list[subprocess.Popen] = []
    for inst in instances:
        procs.append(subprocess.Popen(backend_command(inst), cwd=ROOT))
        procs.append(subprocess.Popen(frontend_command(inst), cwd=FRONTEND_DIR, env=frontend_env(inst)))

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
