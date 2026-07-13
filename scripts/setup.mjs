#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const codex = spawnSync("codex", ["--version"], { encoding: "utf8" });
if (codex.status !== 0) {
  console.error("Codex CLI was not found. Install and sign in to Codex before running the canvas connector.");
  process.exit(1);
}

const linked = spawnSync("npm", ["link", "--silent"], { stdio: "inherit" });
if (linked.status !== 0) process.exit(linked.status || 1);

console.log("\nCodex Canvas is installed.");
console.log("From any terminal, run: codex-canvas");
console.log("The command copies a complete pairing link to your clipboard.");
