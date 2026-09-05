# Python Backend Explorer (MVP)

Point this at an existing Python backend, browse its functions/classes in a
web UI, inspect signatures and source, and execute a function with
JSON-compatible arguments — without modifying the target project.

## How it works

- **Scanner** (`backend/scanner/`): walks the target project with `ast`
  (no imports, no execution) and discovers functions, classes, methods,
  parameters, decorators, and docstrings.
- **API** (`backend/api/`): FastAPI endpoints serving the scan result and
  running functions on request.
- **Runner** (`backend/runner/`): imports *only* the specific function you
  ask to run, builds its arguments from your JSON (auto-constructing
  Pydantic model parameters from dicts), executes it (sync or async), and
  returns output/timing/errors. Output is serialized defensively — bounded
  depth, collection size, and string length — so arbitrary objects and ORM
  results never blow up the response.
- **Frontend** (`frontend/`): React + Vite. Tree browser with search,
  function detail + source view, a JSON input box, and a result/error
  panel.

## Setup

The backend's only dependencies are `fastapi`, `uvicorn`, `pydantic`
(`pytest`/`httpx` for tests) — nothing project-specific. **Run it using an
interpreter that already has the target project's own dependencies
installed** (its existing venv) rather than building cross-venv execution
machinery: since almost any FastAPI-based backend already has fastapi and
pydantic installed, this is usually a no-op.

```bash
# Windows example, using brain's own venv:
D:\code\main\atomics_system\apps\brain\.venv\Scripts\python.exe -m pip install pytest httpx  # only if not already present, for running tests
```

Frontend:

```bash
cd frontend
npm install
```

## Running

Terminal 1 — backend, pointed at a target project:

```bash
python -m backend.main --project D:\code\main\atomics_system\apps\brain
# binds 127.0.0.1:8765 by default — never expose this beyond localhost,
# it executes code from the target project on request.
```

Useful flags:

- `--ignore DIR_NAME` (repeatable) — extra directory names to skip while scanning
- `--working-directory PATH` — cwd the target's code runs from (default: `--project`'s path)
- `--startup-hook module.path:function_name` — a function to run once before
  the first execution, for targets whose real entrypoint does setup outside
  any function you'd call directly (see brain example below)

Terminal 2 — frontend:

```bash
cd frontend
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173).

## Tracing: input and output of every function

Point the explorer at a project's real ASGI app with `--host-app` and it
mounts that app in-process under `/app`, recording — for every request —
the full call tree of the target's own functions: **arguments in, value
out, exception, and duration for each call**.

```bash
python -m backend.main --project D:\code\main\atomics_system\apps\brain ^
    --host-app app.main:app ^
    --internal-key dev-local-placeholder-key
```

Then drive the target through the explorer's port instead of its own:

```bash
# brain's commit route, through the explorer — auth header injected for you
curl -X POST http://127.0.0.1:8765/app/quotation/graph/<quotation_id>/commit
```

### Drop-in mode (trace an existing backend's real traffic)

To trace **every request your Node backend / frontend already sends to
brain**, run the explorer in drop-in mode on the port brain normally uses
and point those callers at it — no path changes, only the port:

```bash
python -m backend.main --project D:\code\main\atomics_system\apps\brain ^
    --host-app app.main:app --host-app-mount "" ^
    --internal-key dev-local-placeholder-key ^
    --port 8000            # whatever port brain normally listens on
```

brain now answers on its own unprefixed paths (`/quotation/...`,
`/health`, `/docs`) on `:8000`, and the explorer's trace API rides
alongside at `:8000/api/traces`. Whoever was calling brain keeps working,
now traced.

The tracer has to be **in the same process as brain** — you can't attach
to a separately-running `uvicorn app.main:app` from outside. Drop-in mode
is one way to get there with zero changes to brain's code; the other is to
add the middleware to brain's own `app/main.py` behind an env flag.

### Live push mode — the "Brain Terminal" (`/viewer/terminal`)

The section above needs the explorer to *host* brain. The **push** path
instead lets brain run as its own normal server and stream telemetry out
to the explorer, which renders it as a live terminal.

Brain side (already wired, behind a flag — see
`atomics_system/apps/brain/app/core/telemetry.py`):

```bash
# brain's own shell
set BRAIN_TELEMETRY_ENABLED=1
set BRAIN_TELEMETRY_SINK_URL=http://127.0.0.1:8765     # this explorer
set BRAIN_TELEMETRY_SELF_URL=http://127.0.0.1:8000     # brain's own base URL
# optional: override the instrumented package list
# set BRAIN_TELEMETRY_MODULES=app.quotation.extraction,app.quotation.graph,...
python -m uvicorn app.main:app --port 8000
```

On startup brain wraps every function in the configured packages (no
decorator, no edits to route or business code), opens one isolated trace
per HTTP request, and POSTs the event stream to this explorer's
`POST /viewer/terminal/ingest` on a non-blocking background queue — if the
explorer is down brain keeps serving and drops events.

Explorer side — just run it and open the page:

```bash
python -m backend.main --project D:\code\main\atomics_system\apps\brain --port 8765
# then open http://127.0.0.1:8765/viewer/terminal
```

The dashboard (dark phosphor-terminal UI) shows each incoming request;
click one to dive into the nested tree of internal calls, each with its
input arguments (cyan), return value (green) or exception (crimson).
Truncated values have a "load full value" button that fetches the
complete object from brain's in-memory ring buffer
(`GET /__telemetry__/value/...`, proxied through the explorer). The "run
test request" panel drives one of brain's own `/viewer/*` dev routes so
you can generate traffic without a separate client.

`GET /viewer/terminal/status` reports the connection: registered brain
URL, event counts, connected dashboards.

Open the **Traces** tab in the UI (or `GET /api/traces`, `GET
/api/traces/{id}`) to see the tree: `commit` → `commit_quotation` →
`_commit_rows` → `resolve` / `chain_gate` / `weight` / `merge.engine` →
`build_ontology_rollup`, each node showing the JSON it received and
returned.

Flags:

- `--host-app module:attr` — the ASGI app object (e.g. `app.main:app`).
  Its lifespan runs (so brain's `init_context_grabber_db` fires) — no
  `--startup-hook` needed for the hosted path.
- `--host-app-mount /app` — URL prefix for the mounted app.
- `--internal-key KEY` / `--internal-key-header NAME` — value injected as
  the internal-service header on every proxied request, so callers don't
  need the target's shared secret (brain rejects un-keyed `/quotation` and
  `/execution` calls). For brain, `KEY` is `INTERNAL_SERVICE_API_KEY` from
  its `.env`.
- `--trace-root PATH` — only calls in files under here are recorded
  (default: `<project>/app` when it exists, else the project root).
- `--max-traces` (50), `--max-trace-calls` (20000), `--max-trace-depth`
  (60) — ring-buffer size and per-trace caps; a trace past the call cap is
  marked `truncated`.

Add `?__trace=0` to any URL to skip tracing for that request.

You can also trace a **single direct execution**: tick "trace nested
calls" in the Functions tab (or `POST
/api/functions/{id}/execute {"arguments": {...}, "trace": true}`), and the
call tree comes back on the result alongside the output.

### How it works / limits

- Uses `sys.monitoring` (PEP 669, Python 3.12+). On older interpreters
  tracing is silently unavailable and the rest of the explorer works
  normally.
- `PY_START` / `PY_RETURN` / `PY_UNWIND` are distinct events, so the tree
  is correct across `await` — a coroutine awaited from another is nested
  under it, not flattened beside it.
- One trace runs at a time: a second request that would be traced waits
  for the first to finish (an `asyncio.Lock`), so every tree is complete
  and never interleaved. Fine for single-developer inspection; not a
  load-testing tool.
- A target's own `@app.middleware("http")` (Starlette `BaseHTTPMiddleware`)
  runs the downstream app in a separate task, so calls above and below
  that boundary show as separate root trees rather than one. Everything
  inside a route handler (plain `await`) nests normally.
- Argument / return values are serialized with the same bounded
  depth/size limits as direct-execution output, and unknown objects (ORM
  rows, DB clients, framework `Request`) are shown as `type` + `repr`
  rather than expanded; Pydantic models and dataclasses are expanded.
- `self` / `cls` are summarized, not serialized.

### Running against `brain` specifically

`brain`'s FastAPI app registers its Beanie/Mongo document models in an
async function its own lifespan calls at startup
(`init_context_grabber_db`). Functions touching those documents (most of
`chat/context_grabber`) will fail until that's run once. Point the
`--startup-hook` flag at it:

```bash
python -m backend.main --project D:\code\main\atomics_system\apps\brain ^
    --startup-hook app.core.chat.context_grabber.database:init_context_grabber_db
```

Functions that don't touch Neo4j/Mongo/LLM APIs — e.g.
`app.quotation.graph.resolution.normalization.normalize_text` — run with no
extra setup at all; try one of those first to confirm everything's wired up.

## Testing

```bash
python -m pytest tests
```

The suite covers the scanner (including a deliberately broken sample file,
and a synthetic project with `.venv`-style noise dirs), the runner
(sync/async execution, Pydantic auto-construction, missing/unexpected
arguments, real exceptions with traceback, instance methods with a default
constructor, cross-module imports), the serializer's depth/size limits, the
full API surface via FastAPI's `TestClient`, and the tracer (nested
sync/async call trees, argument + return capture, exception nodes,
depth/count truncation, receiver summarizing, the hosted-app middleware
end-to-end, and internal-key injection).

The scanner and runner have also been run directly against the real `brain`
project: 219 files scanned, 1535 functions/methods discovered, 0 scan
errors, and `normalize_text` executed successfully end-to-end through the
web UI in a live browser. The tracer has been run against brain's live
server: `GET /app/admin/quotation/graph/summary` produced a correct
7-call tree (`graph_summary` → `_domain_or_404`, `get_graph_client` →
`GraphClient.__init__` → `GraphClient.summary`) with arguments and return
values captured and the injected internal-API-key visible on
`verify_internal_request`.

## Known limitations (by design, for this MVP)

- **No hot code reload.** Rescan refreshes the *browsable* metadata; a
  module already imported into the running explorer process keeps running
  the code it had when first imported. Restart the explorer to pick up
  changes to already-executed functions. (This is what lets the target's
  own module-level singletons — cached settings, DB clients — persist
  across calls the way they would in a normally running process.)
- **`*args` isn't populated.** Parameters can only be supplied by name; a
  function whose only way to receive a value is positional variadic args
  will run with that parameter empty.
- **Instance methods need a no-argument constructor.** Calling `Class.method()`
  auto-constructs `Class()` with no arguments; if that fails, you get a clear
  error naming the class rather than a way to supply constructor arguments.
- **Sync functions block the server** for their duration (single local
  developer use, not a concern for the size of calls this tool targets).
- **No line-level tracing, variable inspection, or profiling.** Call
  trees *are* now recorded (see "Tracing" above — function entry/return
  with arguments and values, via `sys.monitoring`), but not per-line
  execution, locals at arbitrary points, or flamegraph-style timing
  aggregation. Those remain deferred.
