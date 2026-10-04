from __future__ import annotations

from backend.analysis.telelog import normalize_id, parse_source, split_id

MAIN = '''\
# @telelog id=orders.checkout::checkout role=main feature=Checkout parent=- n=1
# purpose: Turn a user's cart into a paid order
# in: cart_id (request body), user_id (JWT), coupon? (request body)
# out: order_id, total, status
# db: carts(r), orders(w), coupons(r)
# algo: 1) load cart 2) price it (price_order) 3) charge payment
@router.post("/checkout")
async def checkout(body): ...
'''


def codes(tag) -> list[str]:
    return [p.code for p in tag.problems]


def test_main_block_full():
    r = parse_source(MAIN)
    assert len(r.tags) == 1 and not r.problems
    t = r.tags[0]
    assert (t.id, t.role, t.feature, t.parent, t.n) == ("orders.checkout:checkout", "main", "Checkout", None, 1)
    assert t.purpose == "Turn a user's cart into a paid order"
    assert [(f.name, f.optional, f.source) for f in t.inputs] == [
        ("cart_id", False, "request body"), ("user_id", False, "JWT"), ("coupon", True, "request body")]
    assert [(f.name, f.source) for f in t.outputs] == [("order_id", None), ("total", None), ("status", None)]
    assert [(d.table, d.mode) for d in t.db] == [("carts", "r"), ("orders", "w"), ("coupons", "r")]
    assert t.algo == ["load cart", "price it (price_order)", "charge payment"]
    assert t.problems == []


def test_binds_above_decorators_and_async():
    r = parse_source(MAIN)
    t = r.tags[0]
    assert t.bound is not None and t.bound.qual == "checkout"
    assert t.bound.line == 8 and t.bound.anchor == 7  # decorator line, not the def line


def test_sub_block_pipe_separated():
    src = (
        "# @telelog id=orders.pricing::price_order role=sub feature=Checkout parent=orders.checkout::checkout n=2\n"
        "# purpose: Apply the best coupon, then compute tax by region\n"
        "# in: cart.items (db:carts), coupon (step:checkout) | out: total\n"
        "def price_order(): ...\n"
    )
    t = parse_source(src).tags[0]
    assert t.parent == "orders.checkout:checkout" and t.n == 2
    assert [(f.name, f.source) for f in t.inputs] == [("cart.items", "db:carts"), ("coupon", "step:checkout")]
    assert [f.name for f in t.outputs] == ["total"]
    assert t.problems == []


def test_helper_one_line_inline_purpose():
    src = (
        "# @telelog id=orders.pricing::round_money role=helper feature=Checkout "
        "parent=orders.pricing::price_order purpose: Round to 2 decimals\n"
        "def round_money(x): ...\n"
    )
    t = parse_source(src).tags[0]
    assert t.role == "helper" and t.purpose == "Round to 2 decimals"
    assert t.parent == "orders.pricing:price_order" and t.problems == []


def test_quoted_feature_with_spaces():
    src = '# @telelog id=a.b::f role=main feature="Order Management" parent=- n=1\ndef f(): ...\n'
    assert parse_source(src).tags[0].feature == "Order Management"


def test_methods_and_nested_functions():
    src = (
        "class Svc:\n"
        "    # @telelog id=m::Svc.run role=sub feature=X parent=- n=1\n"
        "    def run(self):\n"
        "        # @telelog id=m::Svc.run.<locals>.step role=helper feature=X parent=m::Svc.run purpose: inner\n"
        "        def step(): ...\n"
    )
    r = parse_source(src)
    assert [t.bound.qual for t in r.tags] == ["Svc.run", "Svc.run.<locals>.step"]
    assert [s.qual for s in r.functions] == ["Svc.run", "Svc.run.<locals>.step"]


def test_blank_line_breaks_binding():
    src = "# @telelog id=a::f role=main feature=X parent=- n=1\n\ndef f(): ...\n"
    t = parse_source(src).tags[0]
    assert t.bound is None and "unbound" in codes(t)


def test_block_above_class_or_code_is_unbound():
    for below in ("class C: ...\n", "x = 1\n"):
        t = parse_source("# @telelog id=a::C role=main feature=X parent=- n=1\n" + below).tags[0]
        assert t.bound is None and "unbound" in codes(t)


def test_two_blocks_back_to_back_split():
    src = (
        "# @telelog id=a::f role=helper feature=X parent=- purpose: one\n"
        "def f(): ...\n"
        "# @telelog id=a::g role=helper feature=X parent=- purpose: two\n"
        "def g(): ...\n"
    )
    r = parse_source(src)
    assert [t.bound.qual for t in r.tags] == ["f", "g"]


def test_unrelated_comments_before_and_trailing_comments_ignored():
    src = (
        "# just a note\n"
        "# @telelog id=a::f role=helper feature=X parent=- purpose: ok\n"
        "def f(): ...  # @telelog id=a::nope role=main\n"
    )
    r = parse_source(src)
    assert len(r.tags) == 1 and r.tags[0].bound.qual == "f"


def test_id_normalisation_and_split():
    assert normalize_id("a.b::C.m") == "a.b:C.m"
    assert normalize_id("a.b:C.m") == "a.b:C.m"
    assert split_id("a.b:C.m") == ("a.b", "C.m")
    assert split_id("nomodule") is None


def test_field_parsing_with_commas_in_parentheses():
    src = "# @telelog id=a::f role=sub feature=X parent=- n=1\n# in: a (request body, query), b?\ndef f(): ...\n"
    t = parse_source(src).tags[0]
    assert [(f.name, f.optional, f.source) for f in t.inputs] == [("a", False, "request body, query"), ("b", True, None)]


def test_malformed_values_become_problems_not_exceptions():
    src = (
        "# @telelog id=a::f role=boss feature=X parent=- n=abc color=red\n"
        "# purpose: one\n"
        "# purpose: two\n"
        "# nonsense line\n"
        "# in: (broken\n"
        "def f(): ...\n"
    )
    t = parse_source(src).tags[0]
    assert {"bad-field", "unknown-key", "duplicate-key", "bad-line"} <= set(codes(t))
    assert t.bound is not None


def test_syntax_error_and_empty_source_never_raise():
    r = parse_source("def broken(:\n")
    assert r.tags == [] and r.problems and r.problems[0].code == "syntax-error"
    assert parse_source("").tags == []
    assert parse_source("# @telelog\n").tags[0].bound is None


def test_duplicate_qualnames_are_both_listed():
    src = (
        "class C:\n"
        "    @property\n"
        "    def x(self): ...\n"
        "    @x.setter\n"
        "    def x(self, v): ...\n"
    )
    r = parse_source(src)
    assert [s.qual for s in r.functions] == ["C.x", "C.x"]
    assert [s.anchor for s in r.functions] == [2, 4]
