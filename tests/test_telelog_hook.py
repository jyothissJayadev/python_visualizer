"""tests/test_telelog_hook.py — the edit hook: silent unless something needs refreshing, never fails loudly."""

from __future__ import annotations

import importlib.util
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "telelog" / "hook.py"
spec = importlib.util.spec_from_file_location("telelog_hook", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def event(path: str = "/proj/app/x.py", cwd: str = "/proj") -> io.StringIO:
    return io.StringIO(json.dumps({"tool_input": {"file_path": path}, "cwd": cwd}))


def run(stdin, resp=None, env=None, instances: Path | None = None):
    calls: list[str] = []

    def get(url: str):
        calls.append(url)
        if isinstance(resp, Exception):
            raise resp
        return resp or {}

    out = io.StringIO()
    code = hook.run(stdin, out, env if env is not None else {"BRAIN_COLLECTOR_URL": "http://c:1"}, get,
                    instances or Path("/nonexistent"))
    return code, out.getvalue(), calls


def test_silent_when_nothing_to_refresh():
    code, out, calls = run(event(), {"changed": [], "untagged": []})
    assert code == 0 and out == "" and calls and "paths=%2Fproj%2Fapp%2Fx.py" in calls[0]


def test_reports_changed_and_untagged_as_additional_context():
    resp = {"changed": [{"id": "app.x:f", "line": 3}], "untagged": ["app.x:g"]}
    code, out, _ = run(event(), resp)
    ctx = json.loads(out)["hookSpecificOutput"]
    assert code == 0 and ctx["hookEventName"] == "PostToolUse"
    text = ctx["additionalContext"]
    assert "app.x:f (line 3)" in text and "app.x:g" in text and "record_progress" in text
    assert "comment lines" in text  # tells Claude it may only touch the tags


def test_long_lists_are_capped():
    resp = {"changed": [], "untagged": [f"app.x:f{i}" for i in range(40)]}
    text = json.loads(run(event(), resp)[1])["hookSpecificOutput"]["additionalContext"]
    assert text.count("app.x:f") == hook.MAX_LISTED and "more; run validate_tags" in text


def test_ignores_non_python_and_telelog_state_files_without_calling_the_collector():
    for p in ("/proj/README.md", "/proj/.telelog/state/verified.json", "/proj/.telelog/config.py"):
        code, out, calls = run(event(p), {"changed": [{"id": "a:b"}]})
        assert (code, out, calls) == (0, "", [])


def test_never_fails_on_collector_errors_or_garbage_input():
    assert run(event(), ConnectionError("down")) == (0, "", ["http://c:1/viewer/telelog/changed?paths=%2Fproj%2Fapp%2Fx.py"])
    for bad in ("", "not json", "[]", json.dumps({"tool_input": None})):
        assert run(io.StringIO(bad), {"changed": [{"id": "a:b"}]})[:2] == (0, "")


def test_collector_resolved_from_instances_by_the_deepest_matching_root(tmp_path: Path):
    inst = tmp_path / "instances.json"
    inst.write_text(json.dumps({"instances": [
        {"name": "wide", "workspace": "/work", "project": "/work/other", "backend_port": 1111},
        {"name": "arthur", "workspace": "/work/arthur", "project": "/work/arthur/backend", "backend_port": 2222},
    ]}))
    assert hook.resolve_url({}, "/work/arthur/backend/app", inst) == "http://127.0.0.1:2222"
    assert hook.resolve_url({}, "/work/misc", inst) == "http://127.0.0.1:1111"
    assert hook.resolve_url({}, "/elsewhere", inst) is None
    assert hook.resolve_url({"BRAIN_COLLECTOR_URL": "http://h:9/"}, "/elsewhere", inst) == "http://h:9"
    assert hook.resolve_url({"TELELOG_INSTANCES": str(inst)}, "/work/arthur", Path("/nonexistent")) == "http://127.0.0.1:2222"
    assert hook.resolve_url({}, "/work", tmp_path / "missing.json") is None


def test_real_http_round_trip_against_a_fake_collector():
    seen: list[str] = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            seen.append(self.path)
            body = json.dumps({"changed": [{"id": "a:f", "line": 1}], "untagged": []}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):  # silence
            pass

    srv = HTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        out = io.StringIO()
        env = {"BRAIN_COLLECTOR_URL": f"http://127.0.0.1:{srv.server_port}"}
        assert hook.run(event(), out, env) == 0  # default fetch, real socket
        assert "a:f (line 1)" in json.loads(out.getvalue())["hookSpecificOutput"]["additionalContext"]
        assert seen[0].startswith("/viewer/telelog/changed?paths=")
    finally:
        srv.shutdown()
