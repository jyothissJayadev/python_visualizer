"""Seed Trace Templates into a running visualizer instance from a JSON file.

    python scripts/seed_templates.py --instance arthur \
        --file /path/to/backend/visualizer_templates.json

The file is ``{"templates": [{"name": ..., "functions": [{"id": "module:qualname", "deep": bool}]}]}``.
Idempotent: a template whose name already exists (HTTP 409) is left as it is.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.instances import InstanceError, load_instances  # noqa: E402


def post(url: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", required=True)
    ap.add_argument("--file", required=True, type=Path)
    ap.add_argument("--instances-file")
    args = ap.parse_args(argv)
    try:
        instances = load_instances(args.instances_file) if args.instances_file else load_instances()
    except InstanceError as exc:
        ap.error(str(exc))
    if args.instance not in instances:
        ap.error(f"unknown instance {args.instance!r}; known: {list(instances)}")
    base = f"http://127.0.0.1:{instances[args.instance].backend_port}"
    templates = json.loads(args.file.read_text())["templates"]
    failed = 0
    for t in templates:
        try:
            status, body = post(f"{base}/viewer/terminal/templates", t)
        except OSError as exc:
            print(f"cannot reach {base}: {exc}", file=sys.stderr)
            return 1
        label = {201: "created", 409: "exists"}.get(status, f"FAILED {status} {body.get('error', '')}")
        failed += status not in (201, 409)
        print(f"  {t['name']}: {label}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
