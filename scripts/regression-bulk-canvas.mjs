#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { chromium } from "playwright";

const exec = promisify(execFile);
const root = resolve(new URL("..", import.meta.url).pathname);
const token = process.env.CANVAS_TOKEN;
const appUrl = process.env.CANVAS_APP_URL || "http://127.0.0.1:3001";
const sidecar = process.env.CANVAS_SIDECAR_URL || "http://127.0.0.1:4317";
if (!token) throw new Error("Set CANVAS_TOKEN for an isolated test sidecar");

const pairedUrl = `${appUrl}/#sidecar=${encodeURIComponent(sidecar)}&token=${encodeURIComponent(token)}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.stack || error.message));

try {
  await page.goto(pairedUrl, { waitUntil: "networkidle" });
  await page.getByText("Live", { exact: true }).waitFor({ timeout: 15000 });
  await canvasctl(["clear"]);
  await canvasctl(["image", resolve(root, "public/favicon.svg"), "--x", "977", "--y", "695", "--width", "305", "--height", "235"]);
  await canvasctl(["eval", "--file", resolve(root, "scripts/add-30d-forecast.js")]);
  await page.waitForTimeout(1500);

  const failure = page.getByText("Something went wrong", { exact: true });
  if (await failure.count()) {
    const details = page.getByRole("button", { name: "Show details" });
    if (await details.count() === 1) await details.click();
    throw new Error(`tldraw entered its error boundary: ${await page.locator(".tl-error-boundary__content").innerText()}`);
  }

  const snapshot = await getSnapshot();
  if (snapshot.shapes.length !== 34) throw new Error(`Expected the source image plus 33 forecast shapes, found ${snapshot.shapes.length}`);
  const meaningfulErrors = errors.filter((message) => !message.includes("favicon") && !message.includes("Failed to load resource"));
  if (meaningfulErrors.length) throw new Error(`Browser errors:\n${meaningfulErrors.join("\n")}`);
  const screenshot = resolve(root, ".qa-bulk-forecast.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  console.log(JSON.stringify({ ok: true, shapeCount: snapshot.shapes.length, screenshot }, null, 2));
} finally {
  await browser.close();
}

async function canvasctl(args) {
  await exec(resolve(root, "bin/canvasctl"), args, {
    cwd: root,
    env: { ...process.env, CANVAS_TOKEN: token, CANVAS_SIDECAR_URL: sidecar },
    timeout: 60000,
  });
}

async function getSnapshot() {
  const response = await fetch(`${sidecar}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  return response.json();
}
