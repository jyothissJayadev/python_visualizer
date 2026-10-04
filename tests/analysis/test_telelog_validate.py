from __future__ import annotations

from pathlib import Path

from backend.analysis.engine import Analysis
from backend.analysis.telelog import body_fingerprint, current_fingerprints, validate_tags

OK_MAIN = (
    "# @telelog id=shop.orders::checkout role=main feature=Checkout parent=- n=1\n"
    "# purpose: Turn a cart into an order\n"
    "# in: cart_id (request body)\n"
    "# out: order_id\n"
    "# db: orders(w)\n"
    "# algo: 1) price it 2) save\n"
    "def checkout(cart_id):\n"
    "    return price(cart_id)\n"
)
OK_SUB = (
    "# @telelog id=shop.orders::price role=sub feature=Checkout parent=shop.orders::checkout n=2\n"
    "# purpose: Compute the total\n"
    "# in: cart_id (step:checkout)\n"
    "# out: total\n"
    "def price(cart_id):\n"
    "    return 1\n"
)


def project(tmp_path: Path, src: str, name: str = "shop/orders.py") -> Analysis:
    for rel, text in {"shop/__init__.py": "", name: src}.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return Analysis(str(tmp_path))


def codes(report) -> list[str]:
    return sorted(i.code for i in report.errors + report.warnings)


def test_fully_tagged_project_is_clean(tmp_path: Path):
    r = validate_tags(project(tmp_path, OK_MAIN + OK_SUB))
    assert codes(r) == [] and r.tagged == 2 and r.functions == 2


def test_missing_tag_and_exclude(tmp_path: Path):
    a = project(tmp_path, OK_MAIN + "def price(c):\n    return 1\n")
    r = validate_tags(a)
    assert codes(r) == ["missing-tag"] and r.errors[0].id == "shop.orders:price"
    r = validate_tags(a, exclude=lambda f: f.name == "price")
    assert codes(r) == [] and r.functions == 1


def test_id_mismatch_when_tag_names_another_function(tmp_path: Path):
    src = OK_MAIN.replace("shop.orders::checkout role", "shop.orders::other role") + OK_SUB
    assert "id-mismatch" in codes(validate_tags(project(tmp_path, src)))


def test_renamed_function_warns_instead_of_losing_tag(tmp_path: Path):
    a = project(tmp_path, OK_MAIN + OK_SUB)
    verified = current_fingerprints(a)
    renamed = (OK_MAIN + OK_SUB).replace("def price(", "def compute_price(").replace("return price(", "return compute_price(")
    b = project(tmp_path, renamed)
    r = validate_tags(b, verified)
    renamed_issues = [i for i in r.warnings if i.code == "renamed"]
    assert [i.suggestion for i in renamed_issues] == ["shop.orders:compute_price"]
    assert [i.id for i in r.warnings if i.code == "stale"] == ["shop.orders:checkout"]  # its call site changed too
    assert "id-mismatch" not in codes(r) and "missing-tag" not in codes(r)


def test_stale_when_body_changes(tmp_path: Path):
    a = project(tmp_path, OK_MAIN + OK_SUB)
    verified = current_fingerprints(a)
    b = project(tmp_path, (OK_MAIN + OK_SUB).replace("return 1", "return 2"))
    r = validate_tags(b, verified)
    assert [(i.code, i.id) for i in r.warnings] == [("stale", "shop.orders:price")]
    assert validate_tags(a, verified).warnings == []


def test_fingerprint_ignores_name_but_not_body():
    import ast
    f = ast.parse("def a(x):\n    return x + 1\n").body[0]
    g = ast.parse("def b(x):\n    return x + 1\n").body[0]
    h = ast.parse("def a(x):\n    return x + 2\n").body[0]
    assert body_fingerprint(f) == body_fingerprint(g) != body_fingerprint(h)
    assert f.name == "a"  # the original node is not mutated


def test_duplicate_qualname_binds_to_last_definition(tmp_path: Path):
    src = (
        "class C:\n"
        "    # @telelog id=shop.orders::C.x role=helper feature=X parent=- purpose: getter\n"
        "    @property\n"
        "    def x(self): ...\n"
        "    # @telelog id=shop.orders::C.x role=helper feature=X parent=- purpose: setter\n"
        "    @x.setter\n"
        "    def x(self, v): ...\n"
    )
    r = validate_tags(project(tmp_path, src))
    dup = [i for i in r.errors if i.code == "duplicate-id"]
    assert len(dup) == 1 and dup[0].line == 2  # the first (shadowed) definition


def test_parent_links(tmp_path: Path):
    lonely = OK_SUB.replace("parent=shop.orders::checkout", "parent=shop.orders::ghost")
    assert "unknown-parent" in codes(validate_tags(project(tmp_path, OK_MAIN + lonely)))
    cyc_main = OK_MAIN.replace("parent=-", "parent=shop.orders::price")
    r = validate_tags(project(tmp_path, cyc_main + OK_SUB))
    assert codes(r).count("parent-cycle") == 2
    other = OK_SUB.replace("feature=Checkout", "feature=Billing")
    assert "feature-mismatch" in codes(validate_tags(project(tmp_path, OK_MAIN + other)))


def test_caps_and_required_fields(tmp_path: Path):
    long_purpose = "x" * 101
    many = ", ".join(f"f{i}" for i in range(6))
    algo = " ".join(f"{i}) s" for i in range(1, 9))
    src = (
        "# @telelog id=shop.orders::checkout role=main feature=F parent=- n=1\n"
        f"# purpose: {long_purpose}\n# in: a (query)\n# out: {many}\n# db: -\n# algo: {algo}\n"
        "def checkout(): ...\n"
        "# @telelog id=shop.orders::price role=sub feature=F parent=shop.orders::checkout\n"
        "def price(): ...\n"
    )
    r = validate_tags(project(tmp_path, src))
    c = codes(r)
    assert c.count("over-cap") == 3  # purpose, out fields, algo steps
    assert c.count("missing-field") >= 4  # sub: n, purpose, in, out


def test_vocabulary_db_modes_and_role_rules(tmp_path: Path):
    src = (
        "# @telelog id=shop.orders::checkout role=main feature=F parent=- n=1\n"
        "# purpose: p\n# in: a (cookie), b (db:carts), c (step:price), d (db:)\n# out: x\n# db: t(rw), u(x)\n# algo: 1) a\n"
        "def checkout(): ...\n"
        "# @telelog id=shop.orders::price role=helper feature=F parent=shop.orders::checkout\n"
        "# purpose: p\n# db: t(r)\n"
        "def price(): ...\n"
    )
    r = validate_tags(project(tmp_path, src))
    msgs = [i.message for i in r.errors]
    assert sum("is not in the vocabulary" in m for m in msgs) == 2  # cookie, db:
    assert any("mode must be r, w or rw" in m for m in msgs)
    assert any("`db:` is not allowed on a helper" in m for m in msgs)


def test_sub_and_helper_need_parent(tmp_path: Path):
    src = OK_MAIN + OK_SUB.replace("parent=shop.orders::checkout", "parent=-")
    assert "bad-field" in codes(validate_tags(project(tmp_path, src)))


def test_purpose_question_mark_warns_only(tmp_path: Path):
    r = validate_tags(project(tmp_path, OK_MAIN.replace("purpose: Turn a cart into an order", "purpose: ?") + OK_SUB))
    assert r.errors == [] and codes(r) == ["purpose-unknown"]


def test_unbound_block_and_bad_syntax_module_are_reported(tmp_path: Path):
    src = "# @telelog id=shop.orders::f role=main feature=F parent=- n=1\n\n" + OK_MAIN + OK_SUB
    r = validate_tags(project(tmp_path, src))
    assert "unbound" in codes(r) and r.tagged == 2
