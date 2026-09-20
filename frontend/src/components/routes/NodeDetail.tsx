import { useEffect } from "react";
import { routesStore } from "../../lib/routesStore";
import { useRoutes } from "../../lib/useRoutes";
import {
  EDGE_LABEL, edgeConfirmed, findNode, fmtMs, fnRuntime, methodClass, nodeTitle, pathParts, runtimeExtras,
  runtimeView, shortId, timeAgo, fnParentOf,
} from "../../lib/routesUi";
import type { EndpointDetail, FnRuntime, FunctionDetail, LibraryCall, RuntimeOverlay, TreeNode } from "../../lib/routesApi";
import { store } from "../../lib/store";
import { OP_LABEL, tableLabel } from "../../lib/routesData";

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => store.pushToast("Copied"));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rt-field">
      <div className="rt-field-label">{label}</div>
      <div className="rt-field-val">{children}</div>
    </div>
  );
}

function Source({ fn }: { fn: FunctionDetail }) {
  const lines = (fn.source ?? "").split("\n");
  return (
    <div className="rt-source">
      <div className="rt-source-head">
        <span>{fn.file_path}:{fn.line}–{fn.end_line}</span>
        {fn.source_truncated && <span className="rt-tag stub">truncated</span>}
      </div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className="rt-src-line">
            <span className="rt-src-no">{fn.line + i}</span>
            <span>{l || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function Json({ value, truncated }: { value: unknown; truncated?: boolean }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="rt-json">
      {text ?? "null"}
      {truncated && <span className="rt-tag stub"> truncated</span>}
    </pre>
  );
}

function RuntimeSection({ rt }: { rt: FnRuntime }) {
  const last = rt.last;
  return (
    <div className="rt-runtime">
      <div className="rt-runtime-title">Runtime</div>
      <div className="rt-runtime-grid">
        <div><b>{rt.calls}</b><span>calls</span></div>
        <div><b>{rt.requests}</b><span>requests</span></div>
        <div><b>{fmtMs(rt.avg_ms)}</b><span>avg</span></div>
        <div><b>{fmtMs(rt.max_ms)}</b><span>max</span></div>
        <div className={rt.errors ? "bad" : ""}><b>{rt.errors}</b><span>errors</span></div>
      </div>
      {last && (
        <>
          <div className="rt-field-label">Last call{last.ts ? ` · ${timeAgo(last.ts)}` : ""}{last.duration_ms != null ? ` · ${fmtMs(last.duration_ms)}` : ""}</div>
          {last.error && (
            <p className="rt-note warn"><b>{last.error.type}</b>{last.error.message ? `: ${last.error.message}` : ""}</p>
          )}
          <div className="rt-field-label">Arguments</div>
          <Json value={last.args} truncated={last.args_truncated} />
          {!last.error && (
            <>
              <div className="rt-field-label">Returned</div>
              <Json value={last.result} truncated={last.result_truncated} />
            </>
          )}
        </>
      )}
    </div>
  );
}

function RuntimeRequests({ overlay }: { overlay: RuntimeOverlay }) {
  if (!overlay.requests.length) return null;
  return (
    <div className="rt-runtime">
      <div className="rt-runtime-title">Recent requests</div>
      <table className="rt-reqs">
        <tbody>
          {overlay.requests.slice(0, 6).map((r) => (
            <tr key={r.request_id}>
              <td>{timeAgo(r.ts)}</td>
              <td className={r.status && r.status >= 400 ? "bad" : ""}>{r.status ?? "…"}</td>
              <td>{r.duration_ms != null ? fmtMs(r.duration_ms) : ""}</td>
              <td>{r.spans} calls</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const LIB_GROUPS: { kind: LibraryCall["kind"]; title: string; hint: string }[] = [
  { kind: "external", title: "Library & built-in functions", hint: "Functions from installed packages or the standard library — not part of this project" },
  { kind: "class", title: "Classes instantiated", hint: "Classes without their own __init__ (models, dataclasses, exceptions)" },
  { kind: "unresolved", title: "Unresolved calls", hint: "Could not be traced statically: dynamic dispatch, callbacks or untyped objects" },
];

/** Tables reached by the functions this one calls (not by itself). */
function BelowSection({ node }: { node: TreeNode }) {
  const s = useRoutes();
  const total = node.meta?.below_count ?? 0;
  if (total === 0) return null;
  const data = s.nodeLibrary[node.id];
  return (
    <div className="rt-lib-section">
      <div className="rt-field-label" title="Tables touched by functions below this one in the hierarchy">Tables reached below · {total}</div>
      {!data || data === "loading" ? (
        <p className="rt-note"><span className="rt-spinner" /> Loading…</p>
      ) : (
        <ul className="rt-table-list">
          {data.below.map((t) => (
            <li key={t}>
              <button onClick={() => routesStore.openTable(t)} title="Open in the Data view">
                <code>{tableLabel(t)}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The calls a function makes that are NOT nodes in the hierarchy. */
function LibrarySection({ node }: { node: TreeNode }) {
  const s = useRoutes();
  const total = node.meta?.library_count ?? 0;
  if (total === 0) return null;
  const data = s.nodeLibrary[node.id];
  if (!data || data === "loading") return <p className="rt-note"><span className="rt-spinner" /> Loading library calls…</p>;
  return (
    <div className="rt-lib-section">
      {LIB_GROUPS.map((g) => {
        const items = data.items.filter((e) => e.kind === g.kind);
        if (!items.length) return null;
        return (
          <div key={g.kind} className={"rt-lib-group " + g.kind}>
            <div className="rt-field-label" title={g.hint}>{g.title} · {items.reduce((n, e) => n + e.count, 0)}</div>
            <ul>
              {items.map((e) => (
                <li key={e.name} title={e.reason ?? (e.line ? `line ${e.line}` : undefined)}>
                  <code>{e.name}</code>
                  {e.count > 1 && <span className="rt-count">×{e.count}</span>}
                  {e.line ? <span className="rt-loc">:{e.line}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {data.more > 0 && <p className="rt-note">…and {data.more} more.</p>}
    </div>
  );
}

function EndpointOverview({ ep }: { ep: EndpointDetail }) {
  const s = useRoutes();
  return (
    <>
      <div className="rt-drawer-head">
        <span className={"rt-method " + methodClass(ep.method)}>{ep.method}</span>
        <div className="rt-drawer-titles">
          <span className="rt-drawer-title">Endpoint</span>
        </div>
        <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
      </div>
      <div className="rt-drawer-body">
        <div className="rt-path big">
          {pathParts(ep.path).map((p, i) => <span key={i} className={p.param ? "param" : ""}>{p.text}</span>)}
        </div>
        {ep.docstring && <p className="rt-doc-block">{ep.docstring}</p>}
        <Field label="Handler">
          <code className="rt-code-link" onClick={() => copy(ep.handler_id)} title="Copy function id">{ep.handler_id}</code>
        </Field>
        <Field label="Location"><code>{ep.file_path}:{ep.line}</code></Field>
        <Field label="Signature"><code className="rt-sig">{ep.signature}</code></Field>
        {ep.response_model && <Field label="Response model"><code>{ep.response_model}</code></Field>}
        {ep.status_code && <Field label="Status code"><code>{ep.status_code}</code></Field>}
        {ep.dependencies.length > 0 && (
          <Field label="Dependencies">
            <div className="rt-chips">{ep.dependencies.map((d) => <span key={d} className="rt-chip">{d}</span>)}</div>
          </Field>
        )}
        {ep.tags.length > 0 && (
          <Field label="Tags">
            <div className="rt-chips">{ep.tags.map((t) => <span key={t} className="rt-chip dim">{t}</span>)}</div>
          </Field>
        )}
        {ep.factory && (
          <Field label="Built by router factory">
            <code>{ep.factory}</code>
            {Object.keys(ep.bindings).length > 0 && (
              <div className="rt-bindings">
                {Object.entries(ep.bindings).map(([k, v]) => (
                  <div key={k}><span className="k">{k}</span> → <code>{v}</code></div>
                ))}
              </div>
            )}
          </Field>
        )}
        {ep.mount_chain.length > 0 && (
          <Field label="Router chain">
            <ol className="rt-chain">{ep.mount_chain.map((m) => <li key={m}><code>{m}</code></li>)}</ol>
          </Field>
        )}
        {ep.conditional && <p className="rt-note warn">Registered under a condition that could not be evaluated statically.</p>}
        {ep.param_app && <p className="rt-note">Mounted on an <code>app</code> function parameter — assumed to be the root app.</p>}
        {s.runtime && <RuntimeRequests overlay={s.runtime} />}
        <p className="rt-note hint">Select any node in the hierarchy to see its call site, source and how it is reached.</p>
      </div>
    </>
  );
}

function NodeInfo({ node }: { node: TreeNode }) {
  const s = useRoutes();
  const fnId = node.function_id;
  useEffect(() => {
    if (fnId) void routesStore.loadFunction(fnId);
  }, [fnId]);
  // The library-call and "tables below" lists are fetched per node. Ask for them
  // here, whatever selected the node (a click, the keyboard, or an automatic select).
  const nodeId = node.id;
  const needsLists = (node.meta?.library_count ?? 0) > 0 || (node.meta?.below_count ?? 0) > 0;
  useEffect(() => {
    if (needsLists) void routesStore.loadNodeLibrary(nodeId);
  }, [nodeId, needsLists]);
  const fn = fnId ? s.fnDetails[fnId] : undefined;
  const kids = node.children?.length ?? node.children_count ?? 0;
  const graph = node.meta?.graph;
  const view = runtimeView(s.runtime);
  const rt = fnRuntime(node, view);
  const armedLevel = fnId && view ? view.overlay.armed[fnId] : undefined;
  // nearest enclosing function of this node (for edge confirmation / runtime hints)
  const fnParent = fnParentOf(s.tree?.root ?? null, node.id);
  const extras = fnId ? runtimeExtras(fnId, view) : [];

  return (
    <>
      <div className="rt-drawer-head">
        <span className="rt-glyph big k-function">ƒ</span>
        <div className="rt-drawer-titles">
          <div className="rt-drawer-kind">function{node.is_async ? " · async" : ""}</div>
          <div className="rt-drawer-title mono" title={nodeTitle(node)}>{nodeTitle(node)}</div>
        </div>
        <button className="rt-icon-btn" title="Back to endpoint overview" onClick={() => routesStore.selectNode(null)}>←</button>
        <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
      </div>
      <div className="rt-drawer-body">
        {node.edge && node.edge !== "handler" && (
          <Field label="Reached by"><span className={"rt-tag edge-" + node.edge}>{EDGE_LABEL[node.edge] ?? node.edge}</span></Field>
        )}
        {node.call_expr && (
          <Field label={node.call_line ? `Call site · line ${node.call_line}` : "Call site"}>
            <code className="rt-sig">{node.call_expr}</code>
          </Field>
        )}
        {node.cyclic && <p className="rt-note warn">Recursive: this function is already above in the call chain, so it is not expanded again.</p>}
        {node.meta?.stub && <p className="rt-note">Abstract / Protocol method — concrete implementations are listed under a <b>dispatch</b> node when known.</p>}
        {node.meta?.count && node.meta.count > 1 && <Field label="Repeated"><span>{node.meta.count} identical consecutive calls</span></Field>}

        {graph && (
          <Field label={`LangGraph node “${graph.name}”`}>
            {graph.next.length === 0 ? <span className="muted">terminal</span> : (
              <ul className="rt-next">
                {graph.next.map((n, i) => (
                  <li key={i}>→ <code>{n.to}</code>{n.label && n.label !== n.to ? <span className="muted"> when “{n.label}”</span> : null}</li>
                ))}
              </ul>
            )}
          </Field>
        )}

        {fnId && view && (
          rt ? (
            <>
              {edgeConfirmed(fnParent, node, view) && <p className="rt-note ok">✓ This call edge was observed at runtime.</p>}
              <RuntimeSection rt={rt} />
            </>
          ) : (
            <p className="rt-note">
              {armedLevel !== undefined
                ? view.overlay.request_count > 0 ? "Armed, but not called in the observed requests." : "Armed — no request seen yet."
                : "Not armed, so no runtime data. Arm the endpoint handler (deep) to trace everything under it."}
            </p>
          )
        )}
        {extras.length > 0 && (
          <Field label="Called at runtime, missing from the static tree">
            <ul className="rt-next">
              {extras.map((x) => (
                <li key={x.function_id}><code title={x.function_id}>{shortId(x.function_id)}</code> <span className="muted">×{x.calls} · {x.function_id.split(":")[0]}</span></li>
              ))}
            </ul>
          </Field>
        )}

        {fnId && (
          <>
            <Field label="Function"><code className="rt-code-link" onClick={() => copy(fnId)} title="Copy function id">{fnId}</code></Field>
            {fn && typeof fn === "object" && <Field label="Signature"><code className="rt-sig">{fn.signature}</code></Field>}
            {node.doc && <p className="rt-doc-block">{node.doc}</p>}
            {fn === "loading" && <p className="rt-note">Loading source…</p>}
            {fn === "error" && <p className="rt-note warn">Source unavailable.</p>}
            {fn && typeof fn === "object" && (
              <>
                {fn.docstring && fn.docstring.trim() !== node.doc && <p className="rt-doc-block">{fn.docstring}</p>}
                {fn.decorators.length > 0 && <Field label="Decorators"><div className="rt-chips">{fn.decorators.map((d) => <span key={d} className="rt-chip">@{d}</span>)}</div></Field>}
                {fn.source && <Source fn={fn} />}
              </>
            )}
          </>
        )}

        {node.meta?.data && node.meta.data.length > 0 && (
          <div className="rt-lib-section">
            <div className="rt-field-label" title="Read or written directly by this function (helpers it calls list their own tables)">
              Database · {node.meta.data.length} table{node.meta.data.length > 1 ? "s" : ""}
            </div>
            <ul className="rt-table-list">
              {node.meta.data.map((d) => (
                <li key={d.table + d.op + (d.unattributed ? "u" : "")}>
                  {d.unattributed || d.table === "?" ? (
                    <div className="rt-unknown-row" title={d.reason}>
                      <span className="rt-op op-unknown">unknown</span>
                      <span>
                        {d.via ? <code>{d.via}()</code> : "database call"} could not be tied to a table
                        {d.line ? ` (line ${d.line})` : ""}
                      </span>
                    </div>
                  ) : (
                    <button onClick={() => routesStore.openTable(d.table)} title="Open in the Data view">
                      <span className={"rt-op op-" + d.op}>{OP_LABEL[d.op]}</span>
                      <code>{tableLabel(d.table)}</code>
                      {d.uncertain && <span className="rt-uncertain" title="One of several possible labels — chosen at runtime">≈ one of</span>}
                      {d.count > 1 && <span className="rt-count">×{d.count}</span>}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <BelowSection node={node} />

        <LibrarySection node={node} />

        {kids > 0 && (
          <div className="rt-drawer-actions">
            <button className="rt-btn" onClick={() => routesStore.toggle(node.id)}>
              {s.expanded.has(node.id) ? "Collapse" : `Expand (${kids})`}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

export function NodeDetail() {
  const s = useRoutes();
  const node = findNode(s.tree?.root ?? null, s.selectedNodeId ?? "");
  return (
    <aside className="rt-drawer">
      {node ? (
        <NodeInfo node={node} />
      ) : s.endpoint ? (
        <EndpointOverview ep={s.endpoint} />
      ) : s.selectedId ? (
        <>
          <div className="rt-drawer-head">
            <span className="rt-drawer-title">Details</span>
            <span className="rt-spacer" />
            <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
          </div>
          <div className="rt-drawer-empty">
            <span className="rt-spinner" /> Loading endpoint details…
          </div>
        </>
      ) : (
        <>
          <div className="rt-drawer-head">
            <span className="rt-drawer-title">Details</span>
            <span className="rt-spacer" />
            <button className="rt-icon-btn" title="Close details panel" onClick={() => routesStore.setDrawerOpen(false)}>✕</button>
          </div>
          <div className="rt-drawer-empty">Select an endpoint from the left list</div>
        </>
      )}
    </aside>
  );
}
