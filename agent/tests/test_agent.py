"""The agent against a small FastAPI app that has sync (threadpool) and async handlers, nested
calls, a hot loop, an exception and a big domain object."""
import asyncio
import threading

import httpx
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from visualizer_agent import install, monitor, trace
from visualizer_agent.trace import TraceCollector, build_requests

SENT: list[dict] = []          # what the agent's sink "posted" (in-process, never a real network call)


def _record(request: httpx.Request) -> httpx.Response:
    import json
    SENT.append({"url": str(request.url), "body": json.loads(request.content)})
    return httpx.Response(200, json={"ok": True})


@dataclass
class Big:
    name: str
    table: dict = field(default_factory=dict)


def helper_double(x):
    return x * 2


def helper_sum(items):
    return sum(helper_double(i) for i in items)


def hot(i):
    return i + 1


def boom(msg):
    raise ValueError(msg)


def make_app(**kw) -> FastAPI:
    app = FastAPI()

    @app.get("/sync/{n}")
    def sync_handler(n: int):
        return {"total": helper_sum(range(n))}

    @app.get("/async/{n}")
    async def async_handler(n: int):
        await asyncio.sleep(0)
        return {"total": helper_sum(range(n))}

    @app.get("/hot/{n}")
    def hot_handler(n: int):
        for i in range(n):
            hot(i)
        return {"n": n}

    @app.get("/boom")
    def boom_handler():
        try:
            boom("bad input")
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.post("/secret")
    def secret_handler(body: dict):
        return handle_secret(body)

    @app.get("/big")
    def big_handler():
        return {"n": consume_big(Big("x", {str(i): list(range(100)) for i in range(1000)}))}

    kw.setdefault("project_root", Path(__file__).resolve().parent)
    kw.setdefault("package_root", Path(__file__).resolve().parent)
    kw.setdefault("enabled", True)
    kw.setdefault("sink_url", "http://collector.invalid")
    kw.setdefault("self_url", "http://target.invalid")
    kw.setdefault("sink_transport", httpx.MockTransport(_record))
    install(app, **kw)
    return app


def handle_secret(body):
    return {"ok": True}


def consume_big(big):
    return len(big.table)


@pytest.fixture()
def client():
    trace.hub().clear()
    c = TestClient(make_app())
    yield c
    monitor.apply_selection([])
    monitor.uninstall()
    trace.hub().clear()


ME = "tests.test_agent"


def arm(client, *ids, deep=False):
    r = client.post("/__telemetry__/instrument", json={"selections": [{"id": i, "deep": deep} for i in ids]}).json()
    assert r["unresolved"] == [], r
    return r


def reqs():
    return build_requests(trace.hub().snapshot())


def last(path_prefix):
    return [r for r in reqs() if (r["path"] or "").startswith(path_prefix)][-1]


def flat(req):
    out = []
    def walk(nodes):
        for n in nodes:
            out.append(n); walk(n["children"])
    walk(req["spans"])
    return out


@pytest.fixture(autouse=True)
def _module_alias(monkeypatch):
    # ids are module:qualname of *this* module as imported by pytest
    global ME
    ME = __name__


def test_disabled_agent_is_a_no_op():
    app = FastAPI()
    assert install(app, project_root=".", enabled=False) is False
    assert not any(getattr(r, "path", "").startswith("/__telemetry__") for r in app.routes)
    assert app.user_middleware == []


def test_env_enable_and_legacy_aliases(monkeypatch):
    for var in ("VISUALIZER_ENABLED", "BRAIN_TELEMETRY_ENABLED"):
        monkeypatch.delenv("VISUALIZER_ENABLED", raising=False)
        monkeypatch.delenv("BRAIN_TELEMETRY_ENABLED", raising=False)
        monkeypatch.setenv(var, "1")
        assert install(FastAPI(), project_root=".") is True
        monitor.uninstall()


def test_url_settings_precedence_and_cleanup(monkeypatch):
    from visualizer_agent.settings import resolve
    assert resolve(project_root=".").sink_url == ""                     # no default collector
    monkeypatch.setenv("BRAIN_TELEMETRY_SINK_URL", "http://legacy:1  # note")
    assert resolve(project_root=".").sink_url == "http://legacy:1"
    monkeypatch.setenv("VISUALIZER_SINK_URL", "http://new:2/")
    assert resolve(project_root=".").sink_url == "http://new:2"
    assert resolve(project_root=".", sink_url="http://explicit:3").sink_url == "http://explicit:3"


def test_sync_handler_input_output_in_threadpool(client):
    arm(client, f"{ME}:helper_sum")
    assert client.get("/sync/4").json() == {"total": 12}
    req = last("/sync/4")
    assert req["route"] == "/sync/{n}" and req["handler"] == "sync_handler" and req["status"] == 200
    (sp,) = flat(req)
    assert sp["name"] == f"{ME}:helper_sum" and sp["status"] == "ok"
    assert "range(0, 4)" in sp["args"]["items"] and sp["result"] == "12"


def test_async_handler_is_traced_too(client):
    arm(client, f"{ME}:helper_sum")
    client.get("/async/3")
    (sp,) = flat(last("/async/3"))
    assert sp["result"] == "6"


def test_deep_mode_nests_children_and_skips_the_agent(client):
    arm(client, f"{ME}:helper_sum", deep=True)
    client.get("/sync/3")
    req = last("/sync/3")
    (root,) = req["spans"]
    assert root["name"].endswith(":helper_sum")
    children = [c for c in root["children"]]
    assert children and all(c["parent_span_id"] == root["span_id"] for c in children)
    assert not any("visualizer_agent" in s["name"] for s in flat(req))


def test_exception_is_recorded(client):
    arm(client, f"{ME}:boom")
    assert client.get("/boom").status_code == 422
    (sp,) = flat(last("/boom"))
    assert sp["status"] == "error" and sp["exc_type"] == "ValueError" and sp["message"] == "bad input"


def test_unresolved_and_self_tracing_refused(client):
    r = client.post("/__telemetry__/instrument", json={"selections": [
        {"id": f"{ME}:nope"}, {"id": "bad"}, {"id": "visualizer_agent.trace:preview"}]}).json()
    assert r["armed"] == [] and len(r["unresolved"]) == 3
    assert client.post("/__telemetry__/instrument", json={"selections": "x"}).status_code == 400


def test_disarm_stops_recording(client):
    arm(client, f"{ME}:helper_sum")
    client.post("/__telemetry__/instrument", json={"selections": []})
    client.get("/sync/3")
    assert all(not r["spans"] for r in reqs())


def test_hot_function_capture_cap_and_counts():
    trace.hub().clear()
    c = TestClient(make_app(full_capture_per_fn=10))
    try:
        arm(c, f"{ME}:hot")
        c.get("/hot/120")
        req = last("/hot/120")
        sp = flat(req)
        assert len(sp) == 120 and sum(1 for s in sp if s["captured"]) == 10
        assert req["call_counts"][f"{ME}:hot"] == 120
    finally:
        monitor.apply_selection([]); monitor.uninstall()


def test_span_limit_truncates_but_keeps_counting():
    trace.hub().clear()
    c = TestClient(make_app(max_spans_per_request=15))
    try:
        arm(c, f"{ME}:hot")
        c.get("/hot/60")
        req = last("/hot/60")
        assert len(flat(req)) == 15 and req["call_counts"][f"{ME}:hot"] == 60
        assert any(e["kind"] == "log" for e in trace.hub().snapshot())
    finally:
        monitor.apply_selection([]); monitor.uninstall()


def test_secrets_redacted_in_captured_args(client):
    arm(client, f"{ME}:handle_secret")
    client.post("/secret", json={"api_key": "sk-123", "name": "n"})
    (sp,) = flat(last("/secret"))
    assert "sk-123" not in sp["args"]["body"] and "redacted" in sp["args"]["body"]


def test_big_objects_use_registered_summarizer_and_full_value_fetch():
    trace.hub().clear()
    c = TestClient(make_app(summarizers={"Big": lambda b: {"_type": "Big", "name": b.name, "entries": len(b.table)}}))
    try:
        arm(c, f"{ME}:consume_big")
        c.get("/big")
        req = last("/big")
        (sp,) = flat(req)
        assert '"entries": 1000' in sp["args"]["big"] and len(sp["args"]["big"]) < 200     # not walked
        full = c.get(f"/__telemetry__/value/{req['request_id']}/{sp['span_id']}/args").json()["value"]
        assert full["big"] == {"_type": "Big", "name": "x", "entries": 1000}
        assert c.get(f"/__telemetry__/value/{req['request_id']}/{sp['span_id']}/x").status_code == 400
        assert c.get(f"/__telemetry__/value/req_none/{sp['span_id']}/args").status_code == 404
    finally:
        monitor.apply_selection([]); monitor.uninstall()


def test_unsummarised_big_dataclass_is_still_bounded(client):
    arm(client, f"{ME}:consume_big")
    client.get("/big")
    (sp,) = flat(last("/big"))
    assert len(sp["args"]["big"]) <= 601 + 5            # preview is clipped


def test_no_sink_url_means_no_sink_and_no_network(monkeypatch):
    trace.hub().clear()
    app = FastAPI()

    @app.get("/x")
    def x():
        return 1

    install(app, project_root=Path(__file__).parent, enabled=True, sink_url="",
            sink_transport=httpx.MockTransport(lambda r: pytest.fail("must not send")))
    c = TestClient(app)
    try:
        assert c.get("/x").json() == 1
        assert c.get("/__telemetry__/status").json()["sink"] == "disabled"
    finally:
        monitor.uninstall()


def test_sink_registers_and_batches_events_in_the_collector_wire_format():
    SENT.clear()
    trace.hub().clear()
    with TestClient(make_app()) as c:
        arm(c, f"{ME}:helper_sum")
        c.get("/sync/3")
        import time
        deadline = time.time() + 5

        def done():
            kinds = {m["body"]["kind"] for m in SENT}
            ended = any(e["kind"] == "request.end" for m in SENT if m["body"]["kind"] == "events"
                        for e in m["body"]["events"])
            return "register" in kinds and ended            # the handshake and the events race each other

        while time.time() < deadline and not done():
            time.sleep(0.05)
    monitor.apply_selection([]); monitor.uninstall()
    reg = [m["body"] for m in SENT if m["body"]["kind"] == "register"]
    assert reg and reg[0]["brain_base_url"] == "http://target.invalid" and reg[0]["code_fingerprint"]
    assert all(m["url"] == "http://collector.invalid/viewer/terminal/ingest" for m in SENT)
    kinds = [e["kind"] for m in SENT if m["body"]["kind"] == "events" for e in m["body"]["events"]]
    assert {"request.start", "fn.start", "fn.end", "request.end"} <= set(kinds)


def test_sink_cancellation_is_not_swallowed():
    """A failing/hanging collector call must never consume the shutdown cancel()."""
    from visualizer_agent.sink import Sink

    async def scenario():
        def boom(request):
            raise httpx.ConnectError("down")
        s = Sink(sink_url="http://x.invalid", self_url="", project_root=Path("."), package_root=Path("."),
                 transport=httpx.MockTransport(boom))
        s.start()
        trace.hub().publish({"kind": "log", "request_id": "r", "data": {}})
        await asyncio.sleep(0.1)
        for t in s._tasks:
            t.cancel()
        await asyncio.wait_for(asyncio.gather(*s._tasks, return_exceptions=True), 3)
        return [t.done() for t in s._tasks]

    assert asyncio.run(scenario()) == [True, True, True]


def test_telemetry_endpoints_are_not_traced(client):
    client.get("/__telemetry__/status")
    assert not any((r["path"] or "").startswith("/__telemetry__") for r in reqs())


def test_hub_publish_from_threads_reaches_the_loop_in_order():
    hub = trace.TraceHub()

    async def scenario():
        q = hub.subscribe(asyncio.get_running_loop())
        old, trace._hub = trace._hub, hub
        try:
            def producer():
                c = TraceCollector("req_t")
                for i in range(200):
                    c._emit("log", data={"i": i})
            threading.Thread(target=producer).start()
            return [await asyncio.wait_for(q.get(), 2) for _ in range(200)]
        finally:
            trace._hub = old

    assert [e["data"]["i"] for e in asyncio.run(scenario())] == list(range(200))


def test_replay_evicts_whole_requests_oldest_first():
    hub = trace.TraceHub(tail=25)
    for rid in ("a", "b", "c"):
        for i in range(10):
            hub.publish({"kind": "log", "request_id": rid, "data": {"i": i}})
    ids = [e["request_id"] for e in hub.snapshot()]
    assert set(ids) == {"b", "c"} and ids.count("b") == 10
    big = trace.TraceHub(tail=5)
    for i in range(20):
        big.publish({"kind": "log", "request_id": "only", "data": {"i": i}})
    assert len(big.snapshot()) == 20                    # the newest request is never split


def test_summaries_and_previews():
    j = trace.to_jsonable({"api_key": "k", "n": {"password": "x"}, "ok": 1})
    assert j["api_key"] == "«redacted»" and j["n"]["password"] == "«redacted»"
    assert len(trace.to_jsonable(list(range(1000)))) == 201
    p, truncated = trace.preview("x" * 5000)
    assert truncated
