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
const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "ignore", "pipe"] });
let buffer = "";
const publicUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out waiting for cloudflared tunnel")), 30000);
  tunnel.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    process.stderr.write(text);
    buffer += text;
    const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) { clearTimeout(timer); resolve(match[0]); }
  });
  tunnel.once("exit", (code) => reject(new Error(`cloudflared exited with code ${code}`)));
});
await fetch(`http://127.0.0.1:${port}/api/config/public-url`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ url: publicUrl }) });
console.log(`\nHosted canvas: ${webUrl.replace(/\/$/, "")}/#sidecar=${encodeURIComponent(publicUrl)}&token=${encodeURIComponent(token)}`);
console.log("Keep this process running while you use the hosted canvas.\n");

const close = () => { tunnel.kill("SIGTERM"); sidecar.kill("SIGTERM"); };
process.on("SIGINT", close); process.on("SIGTERM", close);
await new Promise((resolve) => sidecar.once("exit", resolve));

function readArg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
async function waitForHealth(url) { for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error("Sidecar did not start"); }
