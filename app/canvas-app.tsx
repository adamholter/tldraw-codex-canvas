"use client";

import {
  Tldraw,
} from "tldraw";
import { getSnapshot, type Editor } from "@tldraw/editor";
import { AssetRecordType, createShapeId, toRichText } from "@tldraw/tlschema";
import "tldraw/tldraw.css";
import { CodexChatEmbed } from "t3-code-ultralight-browser-fork/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Connection = { sidecar: string; token: string };
type CanvasCommand = { id: string; action: string; payload?: any };

function readConnection(): Connection | null {
  if (typeof window === "undefined") return null;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const stored = window.localStorage.getItem("codex-canvas-connection");
  let previous: Partial<Connection> = {};
  try { previous = stored ? JSON.parse(stored) : {}; } catch { /* ignore */ }
  const sidecar = (hash.get("sidecar") || previous.sidecar || "").replace(/\/$/, "");
  const token = hash.get("token") || previous.token || "";
  return sidecar && token ? { sidecar, token } : null;
}

function wsUrl(httpUrl: string) {
  return httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function parsePairing(value: string, fallbackSidecar: string): Connection | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = new URL(input);
    const params = new URLSearchParams(url.hash.replace(/^#/, ""));
    const sidecar = params.get("sidecar")?.replace(/\/$/, "");
    const token = params.get("token");
    if (sidecar && token) return { sidecar, token };
  } catch { /* token-only fallback below */ }
  return /^[A-Za-z0-9_-]{20,}$/.test(input) ? { sidecar: fallbackSidecar.replace(/\/$/, ""), token: input } : null;
}

function compactState(editor: Editor) {
  const shapes = editor.getCurrentPageShapes().map((shape) => ({
    id: shape.id,
    type: shape.type,
    x: Math.round(shape.x),
    y: Math.round(shape.y),
    rotation: shape.rotation,
    props: shape.props,
    meta: shape.meta,
  }));
  return {
    pageId: editor.getCurrentPageId(),
    camera: editor.getCamera(),
    selectedShapeIds: editor.getSelectedShapeIds(),
    viewport: editor.getViewportScreenBounds().toJson(),
    shapes,
  };
}

async function placeImage(editor: Editor, payload: any) {
  const assetId = AssetRecordType.createId();
  const shapeId = createShapeId();
  const width = Number(payload.width || payload.w || 640);
  const height = Number(payload.height || payload.h || 480);
  editor.createAssets([{
    id: assetId,
    type: "image",
    typeName: "asset",
    props: {
      name: payload.name || "Codex image",
      src: payload.url,
      w: width,
      h: height,
      mimeType: payload.mimeType || "image/png",
      isAnimated: false,
    },
    meta: {},
  }]);
  editor.createShape({
    id: shapeId,
    type: "image",
    x: Number(payload.x || 0),
    y: Number(payload.y || 0),
    props: { assetId, w: width, h: height, altText: payload.alt || payload.name || "Image placed by Codex" },
  });
  editor.select(shapeId);
  editor.zoomToSelection({ animation: { duration: 220 } });
  return { assetId, shapeId };
}

async function runCommand(editor: Editor, command: CanvasCommand) {
  const payload = command.payload || {};
  switch (command.action) {
    case "snapshot": return { summary: compactState(editor), snapshot: getSnapshot(editor.store) };
    case "create": editor.createShapes((Array.isArray(payload) ? payload : [payload]).map(normalizeText)); return { created: true };
    case "update": editor.updateShapes((Array.isArray(payload) ? payload : [payload]).map(normalizeText)); return { updated: true };
    case "delete": editor.deleteShapes(Array.isArray(payload) ? payload : payload.ids || [payload.id]); return { deleted: true };
    case "clear": editor.deleteShapes([...editor.getCurrentPageShapeIds()]); return { cleared: true };
    case "image": return placeImage(editor, payload);
    case "zoomToFit": editor.zoomToFit({ animation: { duration: 220 } }); return { zoomed: true };
    case "eval": {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return await new AsyncFunction("editor", "tldraw", "payload", `"use strict";\n${payload.code}`)(
        editor,
        { createShapeId, createAssetId: AssetRecordType.createId, getSnapshot, toRichText, placeImage: (input: any) => placeImage(editor, input) },
        payload,
      );
    }
    default: throw new Error(`Unknown canvas action: ${command.action}`);
  }
}

function normalizeText(shape: any) {
  if (!shape?.props || typeof shape.props.text !== "string") return shape;
  const { text, ...props } = shape.props;
  return { ...shape, props: { ...props, richText: toRichText(text) } };
}

export function CanvasApp() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [draftConnection, setDraftConnection] = useState<Connection>({ sidecar: "http://127.0.0.1:4317", token: "" });
  const [pairingInput, setPairingInput] = useState("");
  const [pairingError, setPairingError] = useState("");
  const [status, setStatus] = useState<"offline" | "connecting" | "connected">("offline");
  const [editor, setEditor] = useState<Editor | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const found = readConnection();
    if (found) { setConnection(found); setDraftConnection(found); }
  }, []);

  const saveConnection = useCallback(() => {
    const next = parsePairing(pairingInput, draftConnection.sidecar) || (draftConnection.token.trim() ? { sidecar: draftConnection.sidecar.replace(/\/$/, ""), token: draftConnection.token.trim() } : null);
    if (!next) { setPairingError("Paste the complete pairing link printed by the connector."); return; }
    setPairingError("");
    window.localStorage.setItem("codex-canvas-connection", JSON.stringify(next));
    window.history.replaceState(null, "", window.location.pathname);
    setDraftConnection(next);
    setConnection(next);
  }, [draftConnection, pairingInput]);

  const pushState = useCallback((target?: WebSocket) => {
    const socket = target || socketRef.current;
    if (!editor || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "canvasState", summary: compactState(editor), snapshot: getSnapshot(editor.store), at: Date.now() }));
  }, [editor]);

  useEffect(() => {
    if (!connection || !editor) return;
    setStatus("connecting");
    const socket = new WebSocket(`${wsUrl(connection.sidecar)}/canvas/${encodeURIComponent(connection.token)}`);
    socketRef.current = socket;
    socket.onopen = () => { setStatus("connected"); pushState(socket); };
    socket.onclose = () => setStatus("offline");
    socket.onerror = () => setStatus("offline");
    socket.onmessage = async (event) => {
      let command: CanvasCommand;
      try { command = JSON.parse(event.data); } catch { return; }
      if (!command?.id || command.action === undefined) return;
      try {
        const result = await runCommand(editor, command);
        socket.send(JSON.stringify({ type: "commandResult", id: command.id, result }));
        pushState(socket);
      } catch (error) {
        socket.send(JSON.stringify({ type: "commandResult", id: command.id, error: error instanceof Error ? error.message : String(error) }));
      }
    };
    const stopListening = editor.store.listen(() => {
      if (stateTimer.current) clearTimeout(stateTimer.current);
      stateTimer.current = setTimeout(() => pushState(socket), 80);
    }, { source: "all", scope: "document" });
    return () => {
      stopListening();
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [connection, editor, pushState]);

  const statusLabel = useMemo(() => status === "connected" ? "Live" : status === "connecting" ? "Connecting" : "Offline", [status]);

  return (
    <main className="app-shell">
      <section className="canvas-stage" aria-label="tldraw canvas">
        <Tldraw
          persistenceKey="codex-canvas"
          licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined}
          onMount={setEditor}
        />
      </section>
      <aside className="sidecar-panel">
        <header className="sidecar-header">
          <div><h1>Codex Canvas</h1><p>Local Codex, live canvas.</p></div>
          <span className={`status status-${status}`}>{statusLabel}</span>
        </header>

        {!connection || status === "offline" ? (
          <form className="pairing-bar" onSubmit={(event) => { event.preventDefault(); saveConnection(); }}>
            <div className="pairing-copy">
              <strong>Connect local Codex</strong>
              <span>Run <code>codex-canvas</code>, then paste the copied pairing link.</span>
            </div>
            <div className="pairing-controls">
              <input aria-label="Pairing link" placeholder="Paste pairing link" value={pairingInput} onChange={(event) => { setPairingInput(event.target.value); setPairingError(""); }} />
              <button type="submit">Connect</button>
            </div>
            {pairingError ? <p className="pairing-error">{pairingError}</p> : null}
          </form>
        ) : null}

        {connection && status !== "offline" ? (
          <CodexChatEmbed
            className="codex-chat-frame"
            bridgeUrl={`${connection.sidecar}/chat?token=${encodeURIComponent(connection.token)}`}
            websocketPath={`/codex/${encodeURIComponent(connection.token)}/ws`}
            statusPath={`/api/codex-status?token=${encodeURIComponent(connection.token)}`}
            onTurnChange={(event) => { if (event.phase === "started") pushState(); }}
            onCodexError={(event) => console.error("Embedded Codex error", event.message)}
            style={{ width: "100%", height: "100%", minHeight: 0, border: 0, borderRadius: 0 }}
          />
        ) : (
          <div className="chat-disconnected"><div className="empty-mark">C</div><h2>Talk to your local Codex</h2><p>Connect the local sidecar to use the complete T3 Code chat.</p></div>
        )}
      </aside>
    </main>
  );
}
