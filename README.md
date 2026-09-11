# Brain Terminal

A live trace & function-I/O inspector for a running Python backend
("brain"). Brain runs as its own normal server and streams telemetry to
this tool, which renders it as a live terminal: pick functions in the
dashboard, hit **Apply**, and watch their arguments, return values,
exceptions, timings and nested calls stream in as requests hit brain.

Nothing is instrumented until you pick functions — unselected code costs
nothing (PEP 669 `sys.monitoring`, armed per code object on brain's side).

## Architecture

- **Scanner** (`backend/scanner/`) — walks brain's source with `ast` (no
  imports, no execution) to produce the function catalogue: every
  function/method, keyed by `module:QualName`.
- **Collector** (`backend/api/viewer.py`) — receives brain's event stream
  at `POST /viewer/terminal/ingest`, fans it out to connected dashboards
  over `WS /viewer/terminal/ws`, and proxies the three things a dashboard
  needs brain to do: apply a selection (→ brain's
  `POST /__telemetry__/instrument`), fetch a full (untruncated) value, and
  run a test request.
- **Frontend** (`frontend/`) — React + Vite + TypeScript. Function
  catalogue, live trace stream with loop folding, and a span inspector
  (input / output / exception / LLM transcript).

## Setup

Backend deps are just `fastapi`, `uvicorn`, `pydantic` (`pytest`/`httpx`
for tests). Run it with any interpreter that has those:

```bash
python -m pip install fastapi "uvicorn[standard]" pydantic
python -m pip install pytest httpx   # tests only
```

Frontend:

```bash
cd frontend
npm install
```

## Running

**One command — backend + frontend together:**

```bash
python -m backend.dev --project D:\code\main\atomics_system\apps\brain
```

- backend → http://127.0.0.1:8011
- frontend → http://localhost:5177 (Vite dev server; proxies `/viewer/*`,
  HTTP + WebSocket, to the backend)

Ctrl+C stops both; if either exits, the other is shut down too. Flags:
`--backend-port` (8011), `--frontend-port` (5177), `--ignore DIR_NAME`
(repeatable). Installed as the `brain-terminal-dev` console script too.

**Brain side** (behind a flag — see
`atomics_system/apps/brain/app/core/telemetry.py`). `BRAIN_TELEMETRY_SINK_URL`
is this tool's backend; `BRAIN_TELEMETRY_SELF_URL` is brain's own base URL
(used by the "run test" button). Set the URLs bare — **no trailing comment
or spaces**; `set FOO=url  # note` in cmd stores the note as part of the
value and the events silently 404.

```powershell
# PowerShell
$env:BRAIN_TELEMETRY_ENABLED = "1"
$env:BRAIN_TELEMETRY_SINK_URL = "http://127.0.0.1:8011"
$env:BRAIN_TELEMETRY_SELF_URL = "http://127.0.0.1:8000"
python -m uvicorn app.main:app --port 8000
```

```cmd
:: cmd.exe — the quotes keep trailing spaces out of the value
  set "BRAIN_TELEMETRY_ENABLED=1"
  set "BRAIN_TELEMETRY_SINK_URL=http://127.0.0.1:8011"
  set "BRAIN_TELEMETRY_SELF_URL=http://127.0.0.1:8000"
  python -m uvicorn app.main:app --port 8000 --reload
```

Or put those three in `atomics_system/apps/brain/.env` (there `#` _is_ a
comment) and launch brain from a shell where they aren't already set —
`load_dotenv()` does not override an existing shell variable.

A startup handshake sends brain's base URL and a git fingerprint of its
source, and repeats every ~30s so a reconnect or brain restart re-arms the
selection automatically (only the first handshake, or one after a real
restart, logs a "brain registered" line — the rest are silent). A
background queue POSTs events (dropping them, never blocking, if this tool
is down).

### Running the pieces separately

```bash
python -m backend.main --project <brain> --port 8011   # backend only
cd frontend && npm run dev                              # frontend only (:5177)
```

`backend.main` flags: `--host` / `--port`, `--ignore DIR_NAME` (repeatable).

**Built frontend:** `cd frontend && npm run build` — the backend then serves
the dashboard directly at http://127.0.0.1:8011/viewer/terminal.

## Using the dashboard

- **Left panel** lists every function/method in brain's source. Search,
  add the ones you want, and for each choose **shallow** (just that call's
  args + return) or **deep** (`↳` → `DEEP`: every nested call under `app/`
  while it runs). Hit **Apply selection** — the set is forwarded to brain
  and armed via `sys.monitoring`. Unresolved ids (renamed/moved) come back
  flagged. Selections persist in `localStorage` and re-apply on reconnect
  or brain restart.
- **Centre stream** shows each request as a group of rows. Runs of 10+
  identical sibling calls fold into one steppable loop row (toggle with
  **Fold loops**). **Selected only** hides requests in which none of your
  selected functions ran.
- **Click a row** to open the inspector: input, output, exception +
  traceback, or — for `llm.call` spans — the prompt transcript and the
  raw / parsed model output. Truncated values have a **Load Full Value**
  button (fetched from brain's ring buffer, proxied).
- **Rescan** (in the picker) re-parses brain's source after you edit it. A
  banner warns when brain's running code differs from the last scan.
- Keyboard: `/` picker · `Esc` close · `j`/`k` navigate · `c` clear ·
  `Space` pause · `Ctrl+B` toggle rail.

`GET /viewer/terminal/status` reports the connection, the applied
selection, and event counts.

## Testing

```bash
python -m pytest tests            # backend
cd frontend && npm run lint       # frontend
cd frontend && npm run build      # frontend typecheck + build
```

The backend suite covers the scanner (including a deliberately broken
sample file and a synthetic project with `.venv`-style noise dirs) and the
collector: the scan-based catalogue, the register handshake, event
fan-out with tail replay, and the apply-selection / get-value / run-test
proxies via FastAPI's `TestClient`.
