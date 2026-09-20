from __future__ import annotations

from backend.analysis.callgraph import N
from backend.analysis.overlay import EndpointMatcher, build_overlay, compute_extras, path_matcher


def _ev(kind, rid, sid=None, parent=None, ts=1.0, **data):
    return {"kind": kind, "request_id": rid, "span_id": sid, "parent_span_id": parent, "ts": ts, "data": data}


def test_matcher_prefers_the_most_specific_endpoint():
    m = EndpointMatcher([
        ("GET /q/{id}", "GET", "/q/{id}"),
        ("GET /q/health", "GET", "/q/health"),
        ("POST /q/{id}", "POST", "/q/{id}"),
    ])
    assert m.match("GET", "/q/health") == "GET /q/health"
    assert m.match("GET", "/q/abc?x=1") == "GET /q/{id}"
    assert m.match("POST", "/q/abc/") == "POST /q/{id}"
    assert m.match("GET", "/nope") is None
    assert path_matcher("/f/{p:path}").fullmatch("/f/a/b/c")


def test_overlay_aggregates_confirms_edges_and_finds_extras():
    matcher = EndpointMatcher([("GET /x/{id}", "GET", "/x/{id}"), ("GET /other", "GET", "/other")])
    events = [
        _ev("request.start", "r1", ts=1, method="GET", path="/x/7"),
        _ev("fn.start", "r1", "s1", None, ts=1.1, name="m:handler", args={"id": "7"}),
        _ev("fn.start", "r1", "s2", "s1", ts=1.2, name="m:load", args={"i": 7}),
        _ev("fn.end", "r1", "s2", "s1", ts=1.3, name="m:load", duration_ms=30, result={"ok": True}),
        _ev("fn.start", "r1", "s3", "s1", ts=1.4, name="m:dynamic"),          # not in the static tree
        _ev("fn.error", "r1", "s3", "s1", ts=1.5, name="m:dynamic", duration_ms=10, exc_type="ValueError", message="boom"),
        _ev("fn.start", "r1", "s4", "s2", ts=1.6, name="m:leaf"),
        _ev("fn.end", "r1", "s4", "s2", ts=1.7, name="m:leaf", duration_ms=5),
        _ev("fn.end", "r1", "s1", None, ts=1.8, name="m:handler", duration_ms=100),
        _ev("request.end", "r1", ts=2, status=200, duration_ms=120),
        # a request for a different endpoint must not leak in
        _ev("request.start", "r2", ts=3, method="GET", path="/other"),
        _ev("fn.start", "r2", "t1", None, ts=3.1, name="m:handler"),
    ]
    ov = build_overlay(events, "GET /x/{id}", matcher, [{"id": "m:handler", "deep": True}])
    assert ov["request_count"] == 1 and ov["requests"][0]["status"] == 200
    load = ov["functions"]["m:load"]
    assert (load["calls"], load["avg_ms"], load["errors"]) == (1, 30.0, 0)
    assert load["last"]["args"] == {"i": 7} and load["last"]["result"] == {"ok": True}
    assert ov["functions"]["m:dynamic"]["errors"] == 1
    assert ov["functions"]["m:dynamic"]["last"]["error"] == {"type": "ValueError", "message": "boom"}
    assert ov["functions"]["m:handler"]["calls"] == 1  # r2's handler span is excluded
    # confirmed = any ancestor relation
    assert {"m:handler>m:load", "m:handler>m:leaf", "m:load>m:leaf"} <= set(ov["confirmed"])
    assert ov["armed"] == {"m:handler": True}

    # static tree: handler -> load -> leaf. `dynamic` is only seen at runtime.
    leaf = N(kind="function", name="leaf", function_id="m:leaf")
    load_n = N(kind="function", name="load", function_id="m:load", children=[leaf])
    root = N(kind="function", name="handler", function_id="m:handler", children=[load_n])
    extras = compute_extras(root, ov["_children"])
    assert extras == {"m:handler": [{"function_id": "m:dynamic", "calls": 1}]}  # leaf is below handler, so not "extra"
