from __future__ import annotations

from backend.analysis.telelog import parse_source
from backend.analysis.telelog_live import is_sensitive, last_call, live_values

TAG = parse_source(
    "# @telelog id=a::f role=sub feature=X parent=- n=1\n"
    "# purpose: p\n"
    "# in: cart_id (request body), user_id (JWT), cart.items (db:carts), coupon? (query), note (query)\n"
    "# out: total\n"
    "def f(cart_id, user_id, cart, coupon, note): ...\n").tags[0]


def span(fid="a:f", args=None, result=None, finish=True, rid="r1", sid="s1"):
    ev = [{"kind": "fn.start", "request_id": rid, "span_id": sid, "ts": 1.0, "data": {"name": fid, "args": args}}]
    if finish:
        ev.append({"kind": "fn.end", "request_id": rid, "span_id": sid, "data": {"result": result}})
    return ev


PARAMS = ["cart_id", "user_id", "cart", "coupon", "note"]


def test_no_trace_and_untagged():
    assert live_values([], "a:f", TAG, PARAMS)["status"] == "no-trace"
    assert live_values(span(args={}), "a:f", None, PARAMS)["status"] == "no-trace"


def test_dict_args_match_by_name_with_nested_path_and_states():
    ev = span(args={"cart_id": 7, "user_id": 9, "cart": {"items": [1, 2]}, "coupon": None}, result={"total": 42.5})
    r = live_values(ev, "a:f", TAG, PARAMS)
    assert r["status"] == "ok" and r["request_id"] == "r1"
    assert r["inputs"]["cart_id"] == {"state": "sample", "value": "7"}
    assert r["inputs"]["cart.items"] == {"state": "sample", "value": "[1, 2]"}
    assert r["inputs"]["coupon"] == {"state": "sample", "value": "null"}
    assert r["inputs"]["note"] == {"state": "no-sample"}  # declared but not in the call
    assert r["inputs"]["user_id"] == {"state": "redacted"}  # source JWT
    assert "9" not in str(r["inputs"]["user_id"])  # the value is never sent
    assert r["outputs"]["total"] == {"state": "sample", "value": "42.5"}


def test_list_and_string_args_are_understood_or_degrade_to_no_sample():
    r = live_values(span(args=[7, 9, {"items": 1}], result=3), "a:f", TAG, PARAMS)
    assert r["inputs"]["cart_id"]["value"] == "7"  # positional, mapped by parameter order
    assert r["outputs"]["total"] == {"state": "sample", "value": "3"}  # single output takes the whole result
    r = live_values(span(args='{"cart_id": 5}', result="x"), "a:f", TAG, PARAMS)
    assert r["inputs"]["cart_id"]["value"] == "5"
    r = live_values(span(args="<object at 0x1>", result="x"), "a:f", TAG, PARAMS)
    assert {v["state"] for k, v in r["inputs"].items() if k != "user_id"} == {"no-sample"}


def test_unfinished_call_has_no_output_samples_and_newest_span_wins():
    ev = span(args={"cart_id": 1}, finish=False, rid="old", sid="a") + span(args={"cart_id": 2}, finish=False, rid="new", sid="b")
    r = live_values(ev, "a:f", TAG, PARAMS)
    assert r["request_id"] == "new" and r["inputs"]["cart_id"]["value"] == "2"
    assert r["outputs"]["total"] == {"state": "no-sample"}
    assert last_call(span(fid="other:g"), "a:f") is None


def test_redaction_rules_and_value_clipping():
    for name in ("password", "api_key", "authToken", "card_number", "Authorization", "session_id"):
        assert is_sensitive(name, "request body"), name
    assert is_sensitive("user_id", "JWT") and is_sensitive("x", "header, query")
    for name in ("cart_id", "total", "order_id", "coupon"):
        assert not is_sensitive(name, "request body"), name
    r = live_values(span(args={"cart_id": "x" * 500}, result={"total": 1}), "a:f", TAG, PARAMS)
    v = r["inputs"]["cart_id"]["value"]
    assert len(v) == 200 and v.endswith("…")
