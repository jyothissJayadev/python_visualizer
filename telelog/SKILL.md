---
name: telelog
description: Write and maintain `@telelog` comment tags above Python functions so the Python Visualizer can show what the code means (features, flows, data in and out, DB tables). Use when writing or editing Python in a project that has `.telelog/`, when a hook says tags are stale or missing, and when the user runs /telelog to audit the whole project.
---

# telelog

Meaning lives in a comment block above each function. The visualizer reads it; nothing runs. You write the
tags, using the `brain-telemetry-*` MCP tools for context. Never change code logic: only add or edit `#`
comment lines that start a `@telelog` block.

## Tag format

A block is contiguous `#` lines directly above `def` / `async def`, above any decorators. No blank line between.

```python
# @telelog id=orders.checkout::checkout role=main feature=Checkout parent=- n=1
# purpose: Turn a user's cart into a paid order
# in: cart_id (request body), user_id (JWT), coupon? (request body)
# out: order_id, total, status
# db: carts(r), orders(w), coupons(r)
# algo: 1) load cart 2) price it 3) charge payment 4) create order 5) send receipt
@router.post("/checkout")
async def checkout(...): ...

# @telelog id=orders.pricing::price_order role=sub feature=Checkout parent=orders.checkout::checkout n=2
# purpose: Apply the best coupon, then compute tax by region
# in: cart.items (db:carts), coupon (step:checkout) | out: total
def price_order(...): ...

# @telelog id=orders.pricing::round_money role=helper feature=Checkout parent=orders.pricing::price_order purpose: Round to 2 decimals
def round_money(...): ...
```

- `id`: `module.path::qualname`, exactly as `get_function` / `list_untagged` return it (swap `:` for `::`).
- `role`: `main` = a feature entry or major orchestrating step (full block); `sub` = a meaningful named step
  (short block); `helper` = utility or glue (one line). Choose honestly. An endpoint is a main; do not repeat its route.
- `feature`: short business name. Reuse names from `get_feature_tree`; do not invent near-duplicates.
  Quote values with spaces: `feature="Order Management"`.
- `parent`: the id of the function that gives this one meaning in the story, `-` only for a top-level main.
  It is the human hierarchy and may differ from the call graph (`suggest_parent` helps). `n`: order among
  siblings; parallel steps share an `n`. Helpers may omit `n`.
- `purpose`: one line, at most 100 characters: why it exists, not what each line does. Cannot tell? Write `purpose: ?`
  and list it in your summary. Never guess.
- `in` / `out`: at most 5 fields each, `?` marks optional. Every input names its source in parentheses from
  this vocabulary only: `request body`, `query`, `path`, `header`, `JWT`, `db:<table>`, `step:<function>`,
  `external:<service>`, `config`. Use `-` for none.
- `db`: `table(r|w|rw)`, on main and sub only. `algo`: main only, at most 7 numbered plain-English steps.
- Never put secrets, tokens or real user data in a tag. Do not paraphrase code.

Depth: main = purpose, in, out, db, algo. sub = purpose, in, out (db if it touches tables). helper = purpose.

## When writing or editing code

1. Every new or changed function gets a correct tag at the depth its role needs.
2. Editing a tagged function: update its tag in the same edit (purpose, in/out, db, algo, parent).
3. Renaming or moving a function: change the tag `id` too. Tests and migrations are skipped by config.
4. When a hook tells you tags are stale or missing, refresh only the functions it lists, then call
   `record_progress` with those ids. That clears the warning.

## When `/telelog` is run (audit)

Work through the MCP tools. Never scan the repo by reading files.

1. `get_progress`, then `get_feature_tree` (to reuse feature names).
2. Loop: `list_untagged(limit=15, cursor=...)`. Endpoints come first, then their direct callees, then the rest.
   For the ids on the page call `get_function(ids)`. Write the missing tags, then `record_progress(ids)`
   for the page. If it reports `not_tagged`, those edits did not land: fix them before moving on.
   Pass `next_cursor` to the next call; it stays valid while you tag.
3. `validate_tags`. Fix every error: orphan or unbound block, id mismatch, duplicate id, unknown parent,
   parent cycle, missing or over-cap field, source outside the vocabulary. For `stale`, check the tag still
   describes the code, edit if not, then `record_progress([id])`. For `renamed`, fix the id.
   Repeat until there are no errors.
4. Report: counts by role, features found, and what needs a human (`purpose: ?`, ambiguous feature).

## Guardrails

- Read only the function you are tagging plus what the MCP returns (callers, callees, tables, route).
- If a tool answers with an error, say so and stop; do not guess a tag.
- Only add or edit `@telelog` comment lines. Never touch code, imports or other comments.
