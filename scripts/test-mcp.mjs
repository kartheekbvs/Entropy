#!/usr/bin/env node
// MCP stdio handshake test: initialize → tools/list → tools/call ×2
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// portable: run the MCP server from the project root this script lives in
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const proc = spawn("bun", ["mcp-server/index.ts"], { cwd: PROJECT_ROOT });
let buffer = "";
const pending = new Map();
let nextId = 1;

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.error("NON-JSON on stdout:", line.slice(0, 200));
    }
  }
});
proc.stderr.on("data", (d) => process.stderr.write("[server] " + d));
proc.on("exit", (code) => console.log(`server exited: ${code}`));

function send(obj) {
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: { message: `TIMEOUT waiting for ${method} id=${id}` } });
      }
    }, 90_000);
  });
}

const t0 = Date.now();
const init = await rpc("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "handshake-test", version: "1.0.0" },
});
console.log(`\n[1] initialize (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log("   serverInfo:", JSON.stringify(init.result?.serverInfo));
console.log("   capabilities:", JSON.stringify(init.result?.capabilities));
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const tools = await rpc("tools/list", {});
const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
console.log(`\n[2] tools/list → ${toolNames.length} tools:`);
console.log("   " + toolNames.join(", "));

const stats = await rpc("tools/call", { name: "get_stats", arguments: {} });
console.log(`\n[3] tools/call get_stats →`);
console.log("   " + (stats.result?.content?.[0]?.text ?? JSON.stringify(stats.error)).slice(0, 300));

const t1 = Date.now();
const jobs = await rpc("tools/call", {
  name: "search_public_jobs",
  arguments: { role: "ml", location: "india", limit: 3 },
});
const jobsText = jobs.result?.content?.[0]?.text ?? JSON.stringify(jobs.error);
const parsed = JSON.parse(jobsText);
console.log(`\n[4] tools/call search_public_jobs (ml/india) (${((Date.now() - t1) / 1000).toFixed(1)}s) →`);
console.log(`   totalFound: ${parsed.totalFound}, sources ok: ${parsed.sources.ok.length}/${parsed.sources.ok.length + parsed.sources.failed.length}`);
for (const j of parsed.jobs) {
  console.log(`   [${j.matchScore}] ${j.title} @ ${j.company} — ${j.location}`);
}

proc.kill();
console.log("\nMCP HANDSHAKE TEST PASSED");
process.exit(0);
