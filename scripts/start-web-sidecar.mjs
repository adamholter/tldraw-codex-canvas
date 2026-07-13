#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sessionFile = resolve(root, ".sidecar-session.json");
const webUrl = (readArg("--web-url") || process.env.CANVAS_WEB_URL || "https://codex-canvas.adamholter.chatgpt.site").replace(/\/$/, "");
const preferredPort = Number(readArg("--port") || process.env.CANVAS_PORT || 4317);
let session = await reusableSession();
let sidecar = null;

if (session) {
  console.log(`Reusing the Codex Canvas sidecar already running on port ${session.port}.`);
  console.log(`Pairing token: ${session.token}`);
} else {
  const port = await findAvailablePort(preferredPort);
  const token = process.env.CANVAS_TOKEN || randomBytes(32).toString("base64url");
  session = { port, token, pid: null };
}

const { port, token } = session;
let tunnelProcess = null;
let publicUrl;
console.log("Creating the secure web connection…");
try {
  const cloudflare = await startCloudflareTunnel(port);
  tunnelProcess = cloudflare.process;
  publicUrl = cloudflare.url;
} catch (error) {
  console.warn(`Cloudflare quick tunnel unavailable (${error.message}). Falling back to Serveo.`);
  const serveo = await startServeoTunnel(port);
  tunnelProcess = serveo.process;
  publicUrl = serveo.url;
}
if (session.pid) await stopSidecar(session.pid);
const env = { ...process.env, CANVAS_TOKEN: token, CANVAS_PORT: String(port), CANVAS_WEB_URL: webUrl, CANVAS_PUBLIC_URL: publicUrl };
sidecar = spawn(process.execPath, [new URL("./sidecar.mjs", import.meta.url).pathname, "--port", String(port), "--web-url", webUrl], { env, stdio: ["ignore", "pipe", "inherit"] });
sidecar.stdout.on("data", (chunk) => process.stdout.write(chunk));
sidecar.once("exit", (code) => { if (code && code !== 0) console.error(`Sidecar exited with code ${code}.`); });
session = await waitForSession(port, token);
const pairedUrl = `${webUrl}/#sidecar=${encodeURIComponent(publicUrl)}&token=${encodeURIComponent(token)}`;
const copied = process.platform === "darwin" && spawnSync("pbcopy", { input: pairedUrl }).status === 0;
console.log(`\nOpen Codex Canvas:\n${pairedUrl}`);
console.log(`\nPairing token: ${token}`);
if (copied) console.log("The complete pairing link is already copied to your clipboard.");
console.log("Keep this process running while you use the hosted canvas.\n");
if (process.argv.includes("--open") && process.platform === "darwin") spawn("open", [pairedUrl], { detached: true, stdio: "ignore" }).unref();

const close = () => { tunnelProcess?.kill("SIGTERM"); sidecar?.kill("SIGTERM"); };
process.on("SIGINT", close); process.on("SIGTERM", close);
await new Promise((resolve) => {
  tunnelProcess?.once("exit", resolve);
  sidecar?.once("exit", resolve);
});

function readArg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
async function reusableSession() {
  try {
    const candidate = JSON.parse(await readFile(sessionFile, "utf8"));
    const response = await fetch(`http://127.0.0.1:${candidate.port}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (response.ok && health.project === "tldraw-codex-canvas" && health.instanceId === candidate.instanceId && health.pid === candidate.pid) return candidate;
  } catch { /* stale or missing */ }
  await unlink(sessionFile).catch(() => {});
  return null;
}
async function waitForSession(port, token) {
  for (let i = 0; i < 80; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.project === "tldraw-codex-canvas") return { version: 1, project: health.project, instanceId: health.instanceId, pid: health.pid, host: "127.0.0.1", port, token };
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The local sidecar did not start. Check that the Codex CLI is installed and signed in.");
}
async function findAvailablePort(preferred) {
  for (let port = preferred; port < preferred + 20; port++) if (await portAvailable(port)) return port;
  throw new Error(`No available sidecar port between ${preferred} and ${preferred + 19}.`);
}
function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
async function stopSidecar(pid) {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Existing sidecar ${pid} did not stop cleanly.`);
}
function startCloudflareTunnel(port) {
  return new Promise((resolve, reject) => {
    const process = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "ignore", "pipe"] });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("timed out")), 20000);
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { process.kill("SIGTERM"); reject(error); }
      else resolve({ process, url });
    };
    process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      buffer += text;
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) finish(null, match[0]);
    });
    process.once("error", finish);
    process.once("exit", (code) => finish(new Error(`exited with code ${code}`)));
  });
}
function startServeoTunnel(port) {
  return new Promise((resolve, reject) => {
    const process = spawn("ssh", ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-R", `80:localhost:${port}`, "serveo.net"], { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Serveo timed out")), 20000);
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { process.kill("SIGTERM"); reject(error); }
      else resolve({ process, url });
    };
    const onData = (chunk) => {
      buffer += chunk.toString().replace(/\x1b\[[0-9;]*m/g, "");
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.serveousercontent\.com/);
      if (match) finish(null, match[0]);
    };
    process.stdout.on("data", onData);
    process.stderr.on("data", onData);
    process.once("error", finish);
    process.once("exit", (code) => finish(new Error(`Serveo exited with code ${code}`)));
  });
}
