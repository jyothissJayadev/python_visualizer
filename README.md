# Brain Terminal

A live trace & function-I/O inspector for running Python (FastAPI) backends. A backend — the
**target** — runs as its own normal server and streams telemetry to a visualizer **instance**,
which renders it as a live terminal: pick functions in the dashboard, hit **Apply**, and watch
their arguments, return values, exceptions, timings and nested calls stream in as requests hit
the target. It also maps the target's endpoints and (where the target has one) its database.

Nothing is instrumented until you pick functions — unselected code costs nothing (PEP 669
`sys.monitoring`, armed per code object on the target's side).

One install can watch several targets at once, each as its own instance (see
[Instances](#instances)). Today: **atomics** (the `brain` service) and **arthur** (PatternNet).

## Architecture

```
  target backend ──events + handshake──▶ collector (instance backend) ◀──WS/REST── dashboard (instance frontend)
   (visualizer_agent)  ◀── arm/disarm, fetch value ──┘
```

- **Scanner** (`backend/scanner/`) — walks the target's source with `ast` (no imports, no
  execution) to produce the function catalogue: every function/method, keyed by `module:QualName`.
- **Agent** (`agent/visualizer_agent/`) — runs *inside the target*. Arms selected functions with
  `sys.monitoring`, records inputs/outputs/exceptions per HTTP request, and streams them to its
  instance. One shared package for every target (see [Target side](#target-side-the-shared-agent)).
- **Collector** (`backend/api/viewer.py`) — receives the event stream at
  `POST /viewer/terminal/ingest`, fans it out to connected dashboards over
  `WS /viewer/terminal/ws` (replaying everything it has buffered, so a request that finished before
  you opened the page is still complete), and proxies what a dashboard needs the target to do:
  apply a selection (→ the target's `POST /__telemetry__/instrument`), fetch a full untruncated
  value, run a test request.
- **Instances** (`backend/instances.py`, `instances.json`) — a named (target, ports, features)
  tuple; each runs as its own collector + dashboard pair.
- **Frontend** (`frontend/`) — React + Vite + TypeScript. Function catalogue, live trace stream
  with loop folding, span inspector, endpoints/flow view, database view, lineage view.

## Setup

Backend deps are just `fastapi`, `uvicorn`, `pydantic`, `httpx` (`pytest` for tests). Run it with
any interpreter that has those:

```bash
python -m pip install fastapi "uvicorn[standard]" pydantic httpx
python -m pip install pytest          # tests only
```

Frontend:

```bash
cd frontend && npm install
```

Each **target** additionally needs the agent in its own venv — see
[Target side](#target-side-the-shared-agent).

## Instances

`instances.json` lists the targets this install can watch:

```json
{ "instances": [
  { "name": "arthur", "project": "/path/to/version_1.1/backend",
    "backend_port": 24812, "frontend_port": 24822,
    "target_url": "http://127.0.0.1:8080", "features": ["terminal", "routes"] } ] }
```

| field | meaning |
|---|---|
| `name` | shown as a badge and in the page title; used by `--instance` |
| `project` | the target's root (the directory that contains its `app/` package) |
| `backend_port` / `frontend_port` | this instance's collector and dashboard (must be unique across instances) |
| `target_url` | the target's own base URL (what it reports as `VISUALIZER_SELF_URL`) |
| `features` | tabs to offer: `terminal` (required), `routes`, `database`, `lineage`, `map` (on by default; opt out with `"disable": ["map"]`). `lineage` also gates the lineage scanner, which runs `node` and reads sibling apps |
| `ignore` | extra directory names to skip while scanning |

Current instances:

| instance | collector | dashboard | tabs |
|---|---|---|---|
| atomics | 24811 | 24821 | terminal, routes, database, lineage |
| arthur | 24812 | 24822 | terminal, routes |

An instance is two processes on its own ports. Instances share no state: separate in-memory
buffers and armed selections, per-project cache files under `.cache/`, and browser storage is per
origin (port). Ports and names are validated at start-up (duplicates are rejected).

## Running

**Start one instance on its own (visualizer only, no target):**

```bash
cd /run/media/jyothiss/main/code/python_visualizer
.venv/bin/python -m backend.dev --instance atomics   # collector :24811, dashboard :24821
.venv/bin/python -m backend.dev --instance arthur    # collector :24812, dashboard :24822
```

Then start the target itself with the env `--list` prints (e.g. atomics: `BRAIN_TELEMETRY_ENABLED=1
BRAIN_TELEMETRY_SINK_URL=http://127.0.0.1:24811 BRAIN_TELEMETRY_SELF_URL=http://127.0.0.1:8000`;
arthur: `VISUALIZER_ENABLED=1 VISUALIZER_SINK_URL=http://127.0.0.1:24812
VISUALIZER_SELF_URL=http://127.0.0.1:8080`). Open the dashboard URL yourself.

**Auto-start everything with `run atomics` / `run arthur`:**

- `run` is a bash function in `~/.bashrc`. It runs `code <project>`, then waits for the instance's
  dashboard port and opens it in the browser (`xdg-open`).
- Each project's `.vscode/tasks.json` has tasks with `runOn: folderOpen` that start the target's
  frontend, its backend, and the visualizer (`backend.dev --instance <name>`), each in its own
  terminal of a shared group. Atomics: `atomics: frontend dev`, `atomics: brain server`,
  `atomics: visualizer`. Arthur: `Arthur: all` (backend, frontend, brain telemetry).
- VS Code only runs those tasks if `"task.allowAutomaticTasks": "on"` is set; each project's
  `.vscode/settings.json` does that. If nothing starts, run *Tasks: Manage Automatic Tasks in
  Folder* and allow them.
- **Re-running restarts everything.** `run X` calls `scripts/run_project.sh X`, which kills the
  listeners on that project's ports (visualizer collector + dashboard, and the target's
  `target_ports` / `target_url` port, all from `instances.json`), closes the project's VS Code window
  (needs `wmctrl` on X11), and reopens it so the tasks start fresh. The browser opens on a cold
  start only. Without `wmctrl` (e.g. Wayland) the servers are stopped and you run *Developer: Reload
  Window* in VS Code to restart the tasks. Preview with `scripts/run_project.sh <name> --dry-run`.
- Visualizer ports (24811/24821 atomics, 24812/24822 arthur) are deliberately outside the common
  dev ranges (3000, 5173, 8000, 8080) and below Linux's ephemeral range (32768+). Change them in
  `instances.json`; add `workspace` and `target_ports` there for new instances.
- Ports are fixed per instance (see the table above); if a start fails, check `ss -ltnp | grep -E ':(24811|24812|24821|24822)'` for a stale process on that port.

**One command per instance (backend + frontend together):**

```bash
python -m backend.dev --list                                  # instances, ports, and the env each target needs
python -m backend.dev --instance arthur                       # one instance
python -m backend.dev --instance atomics --instance arthur    # several (or --all)
```

- collector → `http://127.0.0.1:<backend_port>`; dashboard → `http://127.0.0.1:<frontend_port>`
  (a Vite dev server that proxies `/viewer/*`, HTTP + WebSocket, to *its own* collector).
- Ctrl+C stops everything; if any process exits, the rest are shut down too.
- Ad-hoc, without `instances.json`: `python -m backend.dev --project <root> [--backend-port 24811]
  [--frontend-port 24821] [--ignore DIR_NAME ...]`.
- Also installed as the `brain-terminal-dev` console script.

**Run the pieces separately:**

```bash
python -m backend.main --project <root> --port 24812 --name arthur --features terminal,routes
cd frontend && VIZ_FRONTEND_PORT=24822 BRAIN_TERMINAL_BACKEND_PORT=24812 npm run dev -- --port 24822
```

`backend.main` flags: `--host` / `--port`, `--ignore DIR_NAME` (repeatable), `--name`,
`--features`. **Built frontend:** `cd frontend && npm run build` — the backend then serves the
dashboard itself at `http://127.0.0.1:<backend_port>/viewer/terminal`.

## Target side: the shared agent

A target reports to *its* instance through `agent/` (the `visualizer_agent` package) — the same
code for every target, so a fix lands once. In the target's venv:

```bash
pip install -e /path/to/python_visualizer/agent
```

In the target's app factory (it is a no-op unless enabled, and imports nothing when disabled):

```python
from visualizer_agent import install
install(app, project_root=BACKEND_DIR, package_root=BACKEND_DIR / "app",
        summarizers={"Organism": lambda o: {"_type": "Organism", "id": o.organism_id}})  # optional
```

`summarizers` keep large domain objects (routing tables, models) out of traces: they are matched by
class name and replace the default field-by-field walk.

Start the target with the environment `python -m backend.dev --list` prints for its instance:

```bash
VISUALIZER_ENABLED=1 \
VISUALIZER_SINK_URL=http://127.0.0.1:24812 \    # the instance's collector
VISUALIZER_SELF_URL=http://127.0.0.1:8080 \    # the target's own base URL
./run.sh
```

- There is deliberately **no default `VISUALIZER_SINK_URL`**: with several instances a default
  collector would be a guess, and reporting to the wrong one is worse than reporting to none. If it
  is unset the agent logs a warning and forwards nothing.
- Set URLs bare — **no trailing comment or spaces**. (`set FOO=url  # note` in cmd.exe stores the
  note as part of the value; the agent trims after the first whitespace, but keep them clean.)
- Legacy names still work: `BRAIN_TELEMETRY_ENABLED`, `BRAIN_TELEMETRY_SINK_URL`,
  `BRAIN_TELEMETRY_SELF_URL`. Tuning: `VISUALIZER_MAX_SPANS` (spans recorded per request, default
  5000) and `VISUALIZER_FULL_CAPTURE_PER_FN` (calls per function per request whose arguments/results
  are serialized, default 50). Calls past a cap are still **counted** (`call_counts` on the
  request) and shown as "not captured".
- A startup handshake sends the target's base URL and a git fingerprint of its source, and repeats
  every ~30 s, so a collector restart or a target restart re-arms the selection automatically. Events
  go through a bounded background queue that drops (never blocks the target) if the collector is down.
- Works with sync handlers (run in FastAPI's threadpool) and async handlers alike.
- The `/__telemetry__/*` endpoints are **unauthenticated** and can arm tracing of any function in
  the process. Dev only — never enable the agent in production.

**atomics (brain)** currently still uses its own copies of `monitor.py`/`trace.py`/`telemetry.py`
(`apps/brain/app/core/`, behind `BRAIN_TELEMETRY_ENABLED`); they speak the same protocol, so it works
with the collector as before. Configure it with `BRAIN_TELEMETRY_ENABLED=1`,
`BRAIN_TELEMETRY_SINK_URL=http://127.0.0.1:24811` and `BRAIN_TELEMETRY_SELF_URL=http://127.0.0.1:8000`
in the shell, or in `apps/brain/.env` (there `#` *is* a comment; `load_dotenv()` does not override a
variable already set in the shell). Moving it onto the shared agent is optional and not done yet.

## MCP tools per instance

The `brain-telemetry` MCP server (`python -m backend.mcp_server`) talks to **one** collector, chosen by
`BRAIN_COLLECTOR_URL` (default `http://127.0.0.1:24811`). With several instances, register one MCP
server per instance, each pointing at its own collector. `.mcp.json` ships with:

| MCP server | collector | instance |
|---|---|---|
| `brain-telemetry-atomics` | `http://127.0.0.1:24811` | atomics |
| `brain-telemetry-arthur` | `http://127.0.0.1:24812` | arthur |

```json
"brain-telemetry-arthur": {
  "command": ".venv/bin/python",
  "args": ["-m", "backend.mcp_server"],
  "env": { "BRAIN_COLLECTOR_URL": "http://127.0.0.1:24812" }
}
```

Or from the shell: `claude mcp add brain-telemetry-arthur -e BRAIN_COLLECTOR_URL=http://127.0.0.1:24812 -- .venv/bin/python -m backend.mcp_server`.
The tools appear namespaced by server name (`mcp__brain-telemetry-arthur__arm_functions`, ...), so
pick the server that matches the target you are debugging. Restart Claude Code after editing `.mcp.json`.

## Telelog: what the code means

Telelog adds a human-meaning layer. The coding agent writes a `# @telelog` comment block above each
function (role, feature, parent, purpose, data in and out, DB tables); the **Telelog** view on the Map tab
reads them and shows features, flows, ordered steps and live sample values. The **Deterministic** view stays one
click away. Tags are comments only: nothing is imported or executed, and the visualizer never edits your code.

- **Views:** **City** (default; features are districts, modules are buildings with rooms, tables are vaults,
  streets between buildings are the real function calls that cross them, endpoint flows are highways with a
  gate where each begins, plus guided tours and a day/night map). Select an endpoint and press **Run flow** to
  watch its call order play down through the lower functions (a walkthrough of the code's call order, not a live trace), **Flows** (step-by-step drill-down with the data
  passed between steps) and **Deterministic** (what the code does). The City look follows `project_map.html`.
- **Tag format and audit rules:** `telelog/SKILL.md` (the Claude Code skill; run `/telelog` to tag a project).
- **Install in a target:** `telelog/INSTALL.md` (MCP server entry, skill, edit hook, `.telelog/` config).
- **Tools:** `list_untagged`, `get_function`, `get_feature_tree`, `validate_tags`, `suggest_parent`,
  `check_changed`, `record_progress`, `get_progress` (per instance, like the tools below).
- **State:** `<target>/.telelog/state/` (gitignore it) and `<target>/.telelog/config` (excluded paths; tests,
  migrations and generated code are skipped by default).
- **Design and review notes:** `docs/designs/telelog.md`.

## Using the dashboard

- **Instance badge** (bottom-right) and page title name the target; tabs the instance doesn't offer
  are hidden.
- **Left panel** lists every function/method in the target's source. Search, add the ones you want,
  and for each choose **shallow** (just that call's args + return) or **deep** (`↳` → `DEEP`: every
  nested call under the package root while it runs). Hit **Apply selection** — the set is forwarded
  to the target and armed via `sys.monitoring`. Unresolved ids (renamed/moved) come back flagged.
  Selections persist in `localStorage` and re-apply on reconnect or target restart.
- **Trace templates** save a named set of functions (each with its shallow/deep mode) and re-arm
  them in one click. Seed a target's saved sets from a file:
  `python scripts/seed_templates.py --instance arthur --file <target>/visualizer_templates.json`
  (idempotent: existing names are left alone).
- **Centre stream** shows each request as a group of rows. Runs of 10+ identical sibling calls fold
  into one steppable loop row (toggle with **Fold loops**). **Selected only** hides requests in which
  none of your selected functions ran.
- **Click a row** to open the inspector: input, output, exception + traceback, or — for `llm.call`
  spans — the prompt transcript and the raw / parsed model output. Truncated values have a
  **Load Full Value** button (fetched from the target's ring buffer, proxied).
- **Endpoints** maps each route to the functions it calls (static analysis; no need to run the
  target) and can arm an endpoint's handler ("Arm & trace"). **Database** and **Lineage** are
  atomics-shaped (Mongo/Neo4j tables; brain → backend → client → UI chains) and are off for targets
  that don't have them.
- **Rescan** (in the picker) re-parses the target's source after you edit it. A banner warns when
  the target's running code differs from the last scan.
- Keyboard: `/` picker · `Esc` close · `j`/`k` navigate · `c` clear · `Space` pause · `Ctrl+B` toggle rail.

`GET /viewer/terminal/status` reports the connection, the applied selection, and event counts;
`GET /viewer/instance` reports the instance's name, project and features.

## Testing

```bash
python -m pytest tests agent/tests     # backend + collector, instances, agent, agent<->collector
cd frontend && npm run lint            # frontend
cd frontend && npm run build           # frontend typecheck + build
```

- `tests/` covers the scanner (including a deliberately broken sample file and a synthetic project
  with `.venv`-style noise dirs), the collector (scan-based catalogue, register handshake, event
  fan-out with full-buffer replay, apply-selection / get-value / run-test proxies), instances
  (config validation, distinct ports, launcher commands, `/viewer/instance`, template seeding) and
  an in-process **agent ↔ collector** integration test (`httpx.ASGITransport`, no ports).
- `agent/tests/` covers the agent against a small FastAPI app: sync and async handlers, deep
  nesting, exceptions, caps and call counts, secret redaction, summarizers, thread-safe delivery,
  whole-request eviction, sink protocol, and clean shutdown.
- **Tests never touch the network.** The agent has no default collector and its tests use a mock
  transport, so running them cannot reach a developer's live instance.

## Troubleshooting

| symptom | likely cause |
|---|---|
| Dashboard says the target isn't registered | The target isn't running with the agent enabled, or `VISUALIZER_SINK_URL` points at a different instance than the dashboard you opened. Check `python -m backend.dev --list`. |
| "no sink URL" warning in the target log | `VISUALIZER_SINK_URL` is unset — there is no default. |
| Tracing is off, log mentions the profiler slot | Another tool holds `sys.monitoring`'s profiler slot; only one can. |
| A hot function shows "not captured" | It exceeded `VISUALIZER_FULL_CAPTURE_PER_FN` for that request; it is still counted. |
| Address in use on start | Another process owns the port; change it in `instances.json`. |
