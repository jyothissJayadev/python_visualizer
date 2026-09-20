/* socket.ts — the dashboard WebSocket. Connects to the collector
   (backend/api/viewer.py) at /viewer/terminal/ws, reconnects with backoff,
   and pipes messages into the store. */

import { store } from "./store";
import { routesStore } from "./routesStore";
import { databaseStore } from "./databaseStore";
import type { ClientOp, IncomingMessage } from "../types";

function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host || "127.0.0.1:8765";
  return `${protocol}//${host}/viewer/terminal/ws`;
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let reconnecting = false;
let started = false;

function send(op: ClientOp) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(op));
  }
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnecting = true;
  store.setConnection(
    "reconnecting",
    `Reconnecting (${Math.round(reconnectDelay / 1000)}s)…`,
  );
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnecting = false;
    reconnectDelay = Math.min(reconnectDelay * 1.5, 12000);
    connect();
  }, reconnectDelay);
}

function connect() {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  store.setConnection("connecting", "Connecting…");
  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    console.warn("WS instantiate error:", err);
    scheduleReconnect();
    return;
  }

  socket.onopen = () => {
    reconnecting = false;
    reconnectDelay = 1000;
    store.setConnection("connected", "Connected");
    store.pushToast("WebSocket connected to live backend");
    store.onSocketOpen();
  };

  socket.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data) as IncomingMessage;
      if (typeof msg.kind === "string" && msg.kind.startsWith("analysis_")) {
        routesStore.onAnalysisMessage(msg as unknown as Parameters<typeof routesStore.onAnalysisMessage>[0]);
        if (msg.kind === "analysis_updated") void databaseStore.loadCode(); // the code changed: re-derive the links
      } else {
        store.handleMessage(msg);
        if (msg.kind === "request.end" || msg.kind === "selection_applied") routesStore.onTraceActivity();
      }
    } catch (err) {
      console.error("Failed to parse WS JSON:", err, evt.data);
    }
  };

  socket.onclose = () => scheduleReconnect();

  socket.onerror = (err) => {
    console.warn("WS error event:", err);
    store.setConnection("down", "Connection Error");
  };
}

/** Idempotent — safe to call from React effects (incl. StrictMode double-run). */
export function startSocket() {
  store.setSender(send);
  if (started) return;
  started = true;
  connect();
}
