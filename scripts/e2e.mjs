#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { chromium } from "playwright";

const exec = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const token = process.env.CANVAS_TOKEN;
const appUrl = process.env.CANVAS_APP_URL || "http://localhost:3001";
const sidecar = process.env.CANVAS_SIDECAR_URL || "http://127.0.0.1:4317";
if (!token) throw new Error("Set CANVAS_TOKEN to the token printed by npm run sidecar");
const pairedUrl = `${appUrl}/#sidecar=${encodeURIComponent(sidecar)}&token=${encodeURIComponent(token)}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());

try {
  await page.goto(pairedUrl, { waitUntil: "networkidle" });
  await page.getByText("Live", { exact: true }).waitFor({ timeout: 15000 });

  await canvasctl(["clear"]);
  await canvasctl(["create", JSON.stringify({ type: "note", x: 80, y: 80, props: { color: "yellow", text: "Direct canvasctl works" } })]);
  await canvasctl(["image", resolve(root, "public/favicon.svg"), "--x", "360", "--y", "80", "--width", "180", "--height", "180"]);
  let snapshot = await getSnapshot();
  if (snapshot.shapes.length !== 2 || !JSON.stringify(snapshot).includes("Direct canvasctl works")) throw new Error("Direct create/image verification failed");

  await canvasctl(["clear"]);
  const composer = page.getByLabel("Message Codex");
  await composer.fill("Create one orange note near x 140 y 140 that says LIVE CODEX TEST. Then zoom to fit.");
  await page.getByRole("button", { name: "Send" }).click();
  await poll(async () => JSON.stringify(await getSnapshot()).includes("LIVE CODEX TEST"), 180000);
  await page.locator(".message-assistant").last().filter({ hasNotText: "Working…" }).waitFor({ timeout: 180000 });
  snapshot = await getSnapshot();
  if (!JSON.stringify(snapshot).includes("LIVE CODEX TEST")) throw new Error("Codex did not modify the live canvas");

  await page.screenshot({ path: resolve(root, ".qa-codex-canvas.png"), fullPage: true });
  const meaningfulErrors = consoleErrors.filter((text) => !text.includes("favicon"));
  if (meaningfulErrors.length) throw new Error(`Browser console errors:\n${meaningfulErrors.join("\n")}`);
  console.log(JSON.stringify({ ok: true, shapeCount: snapshot.shapes.length, screenshot: resolve(root, ".qa-codex-canvas.png") }, null, 2));
} finally { await browser.close(); }

async function canvasctl(args) {
  return exec(resolve(root, "bin/canvasctl"), args, { cwd: root, env: { ...process.env, CANVAS_TOKEN: token, CANVAS_SIDECAR_URL: sidecar }, timeout: 60000 });
}
async function getSnapshot() {
  const response = await fetch(`${sidecar}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  return response.json();
}
async function poll(check, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 1000)); }
  throw new Error("Timed out waiting for live Codex canvas edit");
}
