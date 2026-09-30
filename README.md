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
    "backend_port": 8012, "frontend_port": 5178,
    "target_url": "http://127.0.0.1:8080", "features": ["terminal", "routes"] } ] }
```

| field | meaning |
|---|---|
| `name` | shown as a badge and in the page title; used by `--instance` |
| `project` | the target's root (the directory that contains its `app/` package) |
| `backend_port` / `frontend_port` | this instance's collector and dashboard (must be unique across instances) |
| `target_url` | the target's own base URL (what it reports as `VISUALIZER_SELF_URL`) |
| `features` | tabs to offer: `terminal` (required), `routes`, `database`, `lineage`. `lineage` also gates the lineage scanner, which runs `node` and reads sibling apps |
| `ignore` | extra directory names to skip while scanning |

Current instances:

| instance | collector | dashboard | tabs |
|---|---|---|---|
| atomics | 8011 | 5177 | terminal, routes, database, lineage |
| arthur | 8012 | 5178 | terminal, routes |

An instance is two processes on its own ports. Instances share no state: separate in-memory
buffers and armed selections, per-project cache files under `.cache/`, and browser storage is per
origin (port). Ports and names are validated at start-up (duplicates are rejected).

## Running

**One command per instance (backend + frontend together):**

```bash
python -m backend.dev --list                                  # instances, ports, and the env each target needs
python -m backend.dev --instance arthur                       # one instance
python -m backend.dev --instance atomics --instance arthur    # several (or --all)
```

- collector → `http://127.0.0.1:<backend_port>`; dashboard → `http://127.0.0.1:<frontend_port>`
  (a Vite dev server that proxies `/viewer/*`, HTTP + WebSocket, to *its own* collector).
- Ctrl+C stops everything; if any process exits, the rest are shut down too.
- Ad-hoc, without `instances.json`: `python -m backend.dev --project <root> [--backend-port 8011]
  [--frontend-port 5177] [--ignore DIR_NAME ...]`.
- Also installed as the `brain-terminal-dev` console script.

**Run the pieces separately:**

```bash
python -m backend.main --project <root> --port 8012 --name arthur --features terminal,routes
cd frontend && VIZ_FRONTEND_PORT=5178 BRAIN_TERMINAL_BACKEND_PORT=8012 npm run dev -- --port 5178
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
VISUALIZER_SINK_URL=http://127.0.0.1:8012 \    # the instance's collector
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
`BRAIN_TELEMETRY_SINK_URL=http://127.0.0.1:8011` and `BRAIN_TELEMETRY_SELF_URL=http://127.0.0.1:8000`
in the shell, or in `apps/brain/.env` (there `#` *is* a comment; `load_dotenv()` does not override a
variable already set in the shell). Moving it onto the shared agent is optional and not done yet.

## MCP tools per instance

The `brain-telemetry` MCP server (`python -m backend.mcp_server`) talks to **one** collector, chosen by
`BRAIN_COLLECTOR_URL` (default `http://127.0.0.1:8011`). With several instances, register one MCP
server per instance, each pointing at its own collector. `.mcp.json` ships with:

| MCP server | collector | instance |
|---|---|---|
| `brain-telemetry-atomics` | `http://127.0.0.1:8011` | atomics |
| `brain-telemetry-arthur` | `http://127.0.0.1:8012` | arthur |

```json
"brain-telemetry-arthur": {
  "command": ".venv/bin/python",
  "args": ["-m", "backend.mcp_server"],
  "env": { "BRAIN_COLLECTOR_URL": "http://127.0.0.1:8012" }
}
```

Or from the shell: `claude mcp add brain-telemetry-arthur -e BRAIN_COLLECTOR_URL=http://127.0.0.1:8012 -- .venv/bin/python -m backend.mcp_server`.
The tools appear namespaced by server name (`mcp__brain-telemetry-arthur__arm_functions`, ...), so
pick the server that matches the target you are debugging. Restart Claude Code after editing `.mcp.json`.

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
