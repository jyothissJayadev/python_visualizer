# TODOS

## Frontend

### Add a frontend test runner and cover map layout logic

**What:** Add vitest to `frontend/package.json` and write tests for `frontend/src/lib/mapLayout.ts` and the telelog tree/drill-down logic.

**Why:** The Map view has no automated frontend tests, and the telelog feature adds a 4-level drill-down plus filtering logic that will otherwise be checked only by eye.

**Context:** `frontend/package.json` has no `test` script and `frontend/src` has no test files. `mapLayout.ts` (about 111 lines) is pure layout logic and the easiest first target. Source: /plan-eng-review of `docs/designs/telelog.md` (R4, D4).

**Effort:** M
**Priority:** P3
**Depends on:** The telelog nested map UI landing first (Milestone 1)

### Create DESIGN.md and generate telelog mockups

**What:** Run `/design-consultation` to create `DESIGN.md` from the existing `map.css` tokens, and generate mockups of the Telelog flow view once the designer has an API key (`design setup`).

**Why:** The telelog design review had no design system file and no mockups, so visual decisions rest on text specs and the existing Map styles.

**Context:** Source: /plan-design-review of `docs/designs/telelog.md` (Pass 5). `project_map.html` is also still unattached and would feed the mockups.

**Effort:** S
**Priority:** P3
**Depends on:** None
