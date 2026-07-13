#!/usr/bin/env node
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { attachCodexBridge } from "t3-code-ultralight-browser-fork/server";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(readArg("--port") || process.env.CANVAS_PORT || 4317);
const host = readArg("--host") || process.env.CANVAS_HOST || "127.0.0.1";
const token = process.env.CANVAS_TOKEN || randomBytes(32).toString("base64url");
const webUrl = (readArg("--web-url") || process.env.CANVAS_WEB_URL || "http://localhost:3001").replace(/\/$/, "");
const extraOrigins = (process.env.CANVAS_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
const allowedOrigins = [...new Set([webUrl, "http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001", ...extraOrigins])];
const assetsDir = join(root, ".canvas-assets");
const stateFile = join(root, ".canvas-state.json");
const sessionFile = join(root, ".sidecar-session.json");
const instanceId = randomUUID();
let publicBaseUrl = process.env.CANVAS_PUBLIC_URL?.replace(/\/$/, "") || `http://${host}:${port}`;
let canvasSocket = null;
let latestState = { summary: { shapes: [], selectedShapeIds: [] }, snapshot: null, at: 0 };
let stateWrite = Promise.resolve();
const pending = new Map();

await mkdir(assetsDir, { recursive: true });
try { latestState = JSON.parse(await readFile(stateFile, "utf8")); } catch { /* first run */ }

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  const origin = request.headers.origin;
  if (origin && allowedOrigins.includes(origin)) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (request.method === "OPTIONS") return end(response, 204, "");

  if (url.pathname === "/health") return json(response, 200, { ok: true, project: "tldraw-codex-canvas", instanceId, pid: process.pid, port, canvasConnected: canvasSocket?.readyState === WebSocket.OPEN, codexPath: `/codex/${token}/ws` });
  if (url.pathname.startsWith("/assets/")) {
    if (url.searchParams.get("token") !== token) return json(response, 401, { error: "Invalid pairing token" });
    const id = url.pathname.slice("/assets/".length);
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) return json(response, 400, { error: "Invalid asset" });
    try {
      const data = await readFile(join(assetsDir, id));
      response.setHeader("Content-Type", mimeFromExtension(extname(id)));
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      return end(response, 200, data);
    } catch { return json(response, 404, { error: "Asset not found" }); }
  }
  if (!isAuthorized(request, url)) return json(response, 401, { error: "Invalid pairing token" });
  if (url.pathname === "/api/snapshot" && request.method === "GET") {
    return json(response, 200, url.searchParams.get("full") === "1" ? latestState : latestState.summary);
  }
  if (url.pathname === "/api/command" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const result = await issueCommand(body.action, body.payload, Number(body.timeoutMs || 30000));
      return json(response, 200, { ok: true, result });
    } catch (error) { return json(response, 400, { error: message(error) }); }
  }
  if (url.pathname === "/api/assets" && request.method === "POST") {
    try {
      const body = await readJson(request, 32 * 1024 * 1024);
      const extension = safeExtension(body.name, body.mimeType);
      const id = `${randomUUID()}${extension}`;
      await writeFile(join(assetsDir, id), Buffer.from(body.dataBase64, "base64"));
      const assetUrl = `${publicBaseUrl}/assets/${id}?token=${encodeURIComponent(token)}`;
      return json(response, 200, { ok: true, id, url: assetUrl });
    } catch (error) { return json(response, 400, { error: message(error) }); }
  }
  if (url.pathname === "/api/config/public-url" && request.method === "POST") {
    try {
      const body = await readJson(request);
      publicBaseUrl = new URL(body.url).origin;
      return json(response, 200, { ok: true, publicBaseUrl });
    } catch (error) { return json(response, 400, { error: message(error) }); }
  }
  return json(response, 404, { error: "Not found" });
});

const canvasWss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
server.on("upgrade", (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url || "/", "http://127.0.0.1").pathname; } catch { return; }
  if (pathname !== `/canvas/${token}`) return;
  if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) return socket.destroy();
  canvasWss.handleUpgrade(request, socket, head, (webSocket) => canvasWss.emit("connection", webSocket));
});
canvasWss.on("connection", (socket) => {
  if (canvasSocket && canvasSocket.readyState === WebSocket.OPEN) canvasSocket.close(4000, "A newer canvas connected");
  canvasSocket = socket;
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "canvasState") {
        latestState = { summary: message.summary, snapshot: message.snapshot, at: message.at || Date.now() };
        const temp = `${stateFile}.tmp`;
        stateWrite = stateWrite.then(() => writeFile(temp, JSON.stringify(latestState, null, 2))).then(() => rename(temp, stateFile)).catch(() => {});
      } else if (message.type === "commandResult") {
        const entry = pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
      }
    } catch { /* ignore malformed client messages */ }
  });
  socket.on("close", () => { if (canvasSocket === socket) canvasSocket = null; });
});

const bridge = attachCodexBridge(server, {
  path: `/codex/${token}/ws`,
  cwd: root,
  allowedOrigins,
  allowLoopbackOrigins: true,
  env: {
    ...process.env,
    CANVAS_SIDECAR_URL: `http://${host}:${port}`,
    CANVAS_TOKEN: token,
    PATH: `${join(root, "bin")}:${process.env.PATH || ""}`,
  },
  clientInfo: { name: "codex_canvas", title: "Codex Canvas", version: "0.1.0" },
});
bridge.bridge.on("log", (entry) => { if (entry.level === "error") process.stderr.write(`[codex] ${entry.message}\n`); });

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Run the normal \"npm run sidecar\" connector so it can reuse the existing sidecar or choose another port.`);
    process.exitCode = 73;
    return;
  }
  throw error;
});

server.listen(port, host, async () => {
  await writeFile(sessionFile, JSON.stringify({ version: 1, project: "tldraw-codex-canvas", instanceId, pid: process.pid, host, port, token, startedAt: new Date().toISOString() }, null, 2));
  await chmod(sessionFile, 0o600).catch(() => {});
  const localCanvas = `${webUrl}/#sidecar=${encodeURIComponent(`http://${host}:${port}`)}&token=${encodeURIComponent(token)}`;
  console.log(`\nCodex Canvas sidecar is ready.`);
  console.log(`Canvas: ${localCanvas}`);
  console.log(`Pairing token: ${token}`);
  console.log(`API: http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => {
  for (const entry of pending.values()) entry.reject(new Error("Sidecar stopped"));
  await bridge.stop().catch(() => {});
  canvasWss.close();
  await removeOwnSession();
  server.close(() => process.exit(0));
});

process.on("exit", () => { void removeOwnSession(); });

function issueCommand(action, payload, timeoutMs) {
  if (!canvasSocket || canvasSocket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("No live canvas is connected"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Canvas command timed out: ${action}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    canvasSocket.send(JSON.stringify({ id, action, payload }));
  });
}

function readArg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function isAuthorized(request, url) { return request.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token; }
function end(response, status, body) { response.statusCode = status; response.end(body); }
function json(response, status, body) { response.setHeader("Content-Type", "application/json; charset=utf-8"); end(response, status, JSON.stringify(body)); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function mimeFromExtension(extension) { return ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" })[extension.toLowerCase()] || "application/octet-stream"; }
function safeExtension(name = "", mime = "") { const fromName = extname(name).toLowerCase(); if (/^\.(png|jpe?g|gif|webp|svg)$/.test(fromName)) return fromName; return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg" })[mime] || ".bin"; }
async function readJson(request, max = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > max) throw new Error("Request body too large"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
async function removeOwnSession() {
  try {
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    if (session.instanceId === instanceId) await unlink(sessionFile);
  } catch { /* already gone or belongs to another process */ }
}
