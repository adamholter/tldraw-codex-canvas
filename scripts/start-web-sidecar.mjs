#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const webUrl = readArg("--web-url") || process.env.CANVAS_WEB_URL;
if (!webUrl) {
  console.error("Usage: npm run sidecar:web -- --web-url https://your-canvas-site.example");
  process.exit(1);
}
const port = readArg("--port") || "4317";
const token = randomBytes(32).toString("base64url");
const env = { ...process.env, CANVAS_TOKEN: token, CANVAS_WEB_URL: webUrl };
const sidecar = spawn(process.execPath, [new URL("./sidecar.mjs", import.meta.url).pathname, "--port", port, "--web-url", webUrl], { env, stdio: ["ignore", "pipe", "inherit"] });
sidecar.stdout.on("data", (chunk) => process.stdout.write(chunk));

await waitForHealth(`http://127.0.0.1:${port}/health`);
let tunnelProcess = null;
let publicUrl;
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
await fetch(`http://127.0.0.1:${port}/api/config/public-url`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url: publicUrl }) });
console.log(`\nHosted canvas: ${webUrl.replace(/\/$/, "")}/#sidecar=${encodeURIComponent(publicUrl)}&token=${encodeURIComponent(token)}`);
console.log("Keep this process running while you use the hosted canvas.\n");

const close = () => { tunnelProcess?.kill("SIGTERM"); sidecar.kill("SIGTERM"); };
process.on("SIGINT", close); process.on("SIGTERM", close);
await new Promise((resolve) => sidecar.once("exit", resolve));

function readArg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
async function waitForHealth(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error("Sidecar did not start"); }
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
