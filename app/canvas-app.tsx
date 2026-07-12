"use client";

import {
  Tldraw,
} from "tldraw";
import { getSnapshot, type Editor } from "@tldraw/editor";
import { AssetRecordType, createShapeId, toRichText } from "@tldraw/tlschema";
import "tldraw/tldraw.css";
import { createCodexAssistant, type CodexAssistant } from "t3-code-ultralight-browser-fork/assistant";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Connection = { sidecar: string; token: string };
type ChatMessage = { role: "user" | "assistant" | "system"; text: string };
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
  const [status, setStatus] = useState<"offline" | "connecting" | "connected">("offline");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "system", text: "Pair this canvas with the local sidecar to give Codex live canvas access." }]);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const assistantRef = useRef<CodexAssistant | null>(null);
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const found = readConnection();
    if (found) { setConnection(found); setDraftConnection(found); }
  }, []);

  const saveConnection = useCallback(() => {
    const next = { sidecar: draftConnection.sidecar.replace(/\/$/, ""), token: draftConnection.token.trim() };
    if (!next.sidecar || !next.token) return;
    window.localStorage.setItem("codex-canvas-connection", JSON.stringify(next));
    window.history.replaceState(null, "", window.location.pathname);
    setConnection(next);
  }, [draftConnection]);

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

  useEffect(() => {
    if (!connection) return;
    const assistant = createCodexAssistant({
      url: `${wsUrl(connection.sidecar)}/codex/${encodeURIComponent(connection.token)}/ws`,
      requestHandlers: {
        approval: (request) => window.confirm(`Allow Codex to run this action?\n\n${request.method}`) ? "accept" : "decline",
        permission: (request) => window.confirm(`Allow Codex permission?\n\n${request.reason || "Requested for this canvas task"}`) ? { scope: "session" } : null,
        userInput: (questions) => Object.fromEntries(questions.map((question) => [question.id, [window.prompt(question.question, question.options?.[0]?.label || "") || ""]])),
        mcpUrl: (request) => window.confirm(`${request.message}\n\nOpen and authorize ${request.url}?`) ? "accept" : "decline",
      },
    });
    assistantRef.current = assistant;
    return () => { if (assistantRef.current === assistant) assistantRef.current = null; void assistant.close(); };
  }, [connection]);

  const sendPrompt = useCallback(async () => {
    const text = prompt.trim();
    const assistant = assistantRef.current;
    if (!text || !assistant || running) return;
    setPrompt("");
    setRunning(true);
    pushState();
    setMessages((items) => [...items, { role: "user", text }, { role: "assistant", text: "" }]);
    try {
      const answer = await assistant.send(
        `You are attached to a live tldraw canvas. Use canvasctl snapshot before acting, and use canvasctl create, update, delete, image, or eval to directly manipulate it. The canvas state changes live while you work. Do the requested canvas work yourself; do not only describe instructions.\n\nUser request: ${text}`,
        { onDelta: (_delta, fullText) => setMessages((items) => [...items.slice(0, -1), { role: "assistant", text: fullText }]) },
      );
      setMessages((items) => [...items.slice(0, -1), { role: "assistant", text: answer.text }]);
    } catch (error) {
      setMessages((items) => [...items.slice(0, -1), { role: "assistant", text: `Codex error: ${error instanceof Error ? error.message : String(error)}` }]);
    } finally { setRunning(false); }
  }, [prompt, pushState, running]);

  const statusLabel = useMemo(() => status === "connected" ? "Live" : status === "connecting" ? "Connecting" : "Offline", [status]);

  return (
    <main className="app-shell">
      <section className="canvas-stage" aria-label="tldraw canvas">
        <Tldraw persistenceKey="codex-canvas" onMount={setEditor} />
      </section>
      <aside className="sidecar-panel">
        <header className="sidecar-header">
          <div><h1>Codex Canvas</h1><p>Local Codex, live canvas.</p></div>
          <span className={`status status-${status}`}>{statusLabel}</span>
        </header>

        {!connection || status === "offline" ? (
          <div className="pairing-card">
            <h2>Connect sidecar</h2>
            <p>Run <code>npm run sidecar</code>, then use the URL and pairing token it prints.</p>
            <label>Sidecar URL<input value={draftConnection.sidecar} onChange={(e) => setDraftConnection((value) => ({ ...value, sidecar: e.target.value }))} /></label>
            <label>Pairing token<input type="password" value={draftConnection.token} onChange={(e) => setDraftConnection((value) => ({ ...value, token: e.target.value }))} /></label>
            <button onClick={saveConnection}>Connect</button>
          </div>
        ) : null}

        <div className="messages" aria-live="polite">
          {messages.map((message, index) => (
            <article key={index} className={`message message-${message.role}`}>
              <span>{message.role === "assistant" ? "Codex" : message.role === "user" ? "You" : "Canvas"}</span>
              <p>{message.text || (running ? "Working…" : "")}</p>
            </article>
          ))}
        </div>

        <div className="composer">
          <textarea
            aria-label="Message Codex"
            placeholder="Ask Codex to draw, organize, annotate, or add an image…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendPrompt(); } }}
          />
          <div className="composer-actions">
            <button className="secondary" disabled={!running} onClick={() => assistantRef.current?.stop()}>Stop</button>
            <button disabled={!connection || status !== "connected" || running || !prompt.trim()} onClick={() => void sendPrompt()}>Send</button>
          </div>
        </div>
      </aside>
    </main>
  );
}
