# Brain Terminal — frontend

React 19 + TypeScript + Vite. The port of what used to be
`terminal.html` — a single-file vanilla-JS app — into components.

## Layout

- `src/lib/store.ts` — the engine. A single mutable store that ingests
  trace events / control-plane messages, maintains the span & request
  graph, computes loop folding and row visibility, and exposes an
  immutable snapshot to React via `useSyncExternalStore`
  (`src/lib/useTerminal.ts`). rAF-coalesced so event bursts render at
  ~60fps.
- `src/lib/socket.ts` — the dashboard WebSocket (`/viewer/terminal/ws`),
  reconnect with backoff, wired to the store.
- `src/lib/format.ts` — duration / timestamp / args-preview / JSON
  tokenizer helpers.
- `src/types.ts` — wire types (events, catalogue, WS messages) + derived
  types.
- `src/components/` — `Toolbar`, `CatalogPane`, `CatalogModal`,
  `StreamPane` (+ `StreamRows`), `InspectorPane`, `ShortcutsModal`,
  `Toast`.
- `src/terminal.css` — the phosphor-terminal theme (carried over verbatim).

## Scripts

```bash
npm run dev      # Vite dev server on :5177; proxies /viewer/* to backend :8011
npm run build    # tsc -b && vite build  (base: /viewer/terminal/)
npm run lint     # oxlint
```

Or run both halves at once from the repo root:
`python -m backend.dev --project <brain>`.

`npm run build` emits to `dist/`, which the backend serves at
`/viewer/terminal`.
