#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// MCP v3 handshake E2E test — spawns the real server over stdio
// and verifies: initialize → tools/list → job tool → coding
// tools (mkdir/write/read/search/shell) → agent-goal guard →
// resources list/read → ping → audit log.
// Run: node scripts/test-mcp-v3.mjs
// ─────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { once } from "node:events";
import { access } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const PROC = "bun";
const ARGS = ["mcp-server/index.ts"];
const TIMEOUT_MS = 120_000;

const child = spawn(PROC, ARGS, { cwd: ROOT, env: { ...process.env, AGENT_WORKSPACE: "" } });
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

const pending = new Map();
let nextId = 1;
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const msg = JSON.parse(t);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      console.error(`[warn] non-JSON stdout line: ${t.slice(0, 120)}`);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method} (id=${id})`));
    }, 60_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
}

const failures = [];
function check(label, cond, extra = "") {
  if (cond) {
    console.log(`  ✅ ${label}`);
  } else {
    failures.push(label + (extra ? ` — ${extra}` : ""));
    console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

const toolResult = (msg) => msg.result?.content?.[0]?.text ?? "";

try {
  const overall = setTimeout(() => {
    console.error("FATAL: overall timeout — killing server");
    child.kill("SIGKILL");
    process.exit(1);
  }, TIMEOUT_MS);

  // 1. initialize
  console.log("\n[1] initialize …");
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: {} },
    clientInfo: { name: "mcp-v3-test", version: "1.0.0" },
  });
  check("initialize returns server info", init.result?.serverInfo?.name === "job-command-center", JSON.stringify(init.result?.serverInfo));
  check("server version is 3.x", (init.result?.serverInfo?.version ?? "").startsWith("3."), String(init.result?.serverInfo?.version));
  check("tools capability advertised", Boolean(init.result?.capabilities?.tools));
  check("resources capability advertised", Boolean(init.result?.capabilities?.resources));
  notify("notifications/initialized");

  // 2. tools/list
  console.log("\n[2] tools/list …");
  const tools = await send("tools/list", {});
  const names = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`  server exposes ${names.length} tools`);
  for (const expected of [
    "get_profile", "search_public_jobs", "analyze_jd", "add_application", "get_stats", "get_board_links",
    "workspace_info", "fs_list", "fs_read", "fs_write", "fs_edit", "fs_copy", "fs_move", "fs_mkdir", "fs_delete", "fs_search", "fs_glob", "fs_grep", "fs_tree", "todo_write", "todo_read", "shell_run",
    "run_agent_goal", "run_coding_goal", "agent_health",
  ]) {
    check(`tool listed: ${expected}`, names.includes(expected));
  }

  // 3. coding tools round-trip
  console.log("\n[3] coding tools round-trip …");
  const mkdir = await send("tools/call", { name: "fs_mkdir", arguments: { path: "handshake-test" } });
  check("fs_mkdir ok", toolResult(mkdir).replace(/\s+/g, "").includes('"created":true'), toolResult(mkdir).slice(0, 200));

  const write = await send("tools/call", {
    name: "fs_write",
    arguments: { path: "handshake-test/hello.txt", content: "MCP v3 handshake OK" },
  });
  check("fs_write ok", toolResult(write).includes('"bytes"'), toolResult(write).slice(0, 200));

  const read = await send("tools/call", { name: "fs_read", arguments: { path: "handshake-test/hello.txt" } });
  check("fs_read returns content", toolResult(read).includes("MCP v3 handshake OK"), toolResult(read).slice(0, 200));

  const search = await send("tools/call", { name: "fs_search", arguments: { pattern: "handshake" } });
  check("fs_search finds the file", toolResult(search).includes("hello.txt"), toolResult(search).slice(0, 200));

  const list = await send("tools/call", { name: "fs_list", arguments: { path: "handshake-test" } });
  check("fs_list lists entries", toolResult(list).replace(/\s+/g, "").includes('"count":1'), toolResult(list).slice(0, 200));

  // 3b. Claude-Code-parity tools: fs_edit / fs_copy / fs_move / fs_glob / fs_grep / fs_tree / todos
  console.log("\n[3b] Claude-Code-parity tools …");
  const edit = await send("tools/call", {
    name: "fs_edit",
    arguments: { path: "handshake-test/hello.txt", old_string: "MCP v3 handshake OK", new_string: "MCP v3 handshake EDITED" },
  });
  check("fs_edit replaces exactly", toolResult(edit).includes('"occurrences":1') || toolResult(edit).includes("EDITED"), toolResult(edit).slice(0, 300));

  const editAmbWrite = await send("tools/call", {
    name: "fs_write",
    arguments: { path: "handshake-test/amb.txt", content: "dup line one\ndup line two" },
  });
  check("fs_write amb fixture", toolResult(editAmbWrite).includes('"bytes"'), toolResult(editAmbWrite).slice(0, 200));
  const editAmbiguous = await send("tools/call", {
    name: "fs_edit",
    arguments: { path: "handshake-test/amb.txt", old_string: "dup", new_string: "x" },
  });
  check("fs_edit rejects ambiguous match", toolResult(editAmbiguous).includes("times"), toolResult(editAmbiguous).slice(0, 300));

  const copy = await send("tools/call", { name: "fs_copy", arguments: { from: "handshake-test/hello.txt", to: "handshake-test/hello-copy.txt" } });
  check("fs_copy ok", toolResult(copy).replace(/\s+/g, "").includes('"copied":true'), toolResult(copy).slice(0, 200));

  const move = await send("tools/call", { name: "fs_move", arguments: { from: "handshake-test/hello-copy.txt", to: "handshake-test/renamed.txt" } });
  check("fs_move ok", toolResult(move).replace(/\s+/g, "").includes('"moved":true'), toolResult(move).slice(0, 200));

  const glob = await send("tools/call", { name: "fs_glob", arguments: { pattern: "handshake-test/*.txt" } });
  check("fs_glob finds files", toolResult(glob).includes("hello.txt") && toolResult(glob).includes("renamed.txt"), toolResult(glob).slice(0, 300));

  const grep = await send("tools/call", { name: "fs_grep", arguments: { pattern: "EDITED", path: "handshake-test" } });
  check("fs_grep regex search hits", toolResult(grep).includes('"matches":1') || toolResult(grep).includes("EDITED"), toolResult(grep).slice(0, 300));

  const tree = await send("tools/call", { name: "fs_tree", arguments: { path: ".", depth: 2 } });
  check("fs_tree renders tree", toolResult(tree).includes("handshake-test"), toolResult(tree).slice(0, 200));

  const todo = await send("tools/call", {
    name: "todo_write",
    arguments: { todos: [
      { content: "Verify MCP v3", status: "completed" },
      { content: "Verify Claude-Code tools", status: "in_progress" },
    ] },
  });
  check("todo_write ok", toolResult(todo).replace(/\s+/g, "").includes('"summary":"1/2done"'), toolResult(todo).slice(0, 300));

  const todoRead = await send("tools/call", { name: "todo_read", arguments: {} });
  check("todo_read returns plan", toolResult(todoRead).includes("Verify Claude-Code tools"), toolResult(todoRead).slice(0, 300));

  // 4. shell_run — real host execution
  console.log("\n[4] shell_run (real execution) …");
  const shell = await send("tools/call", { name: "shell_run", arguments: { command: 'node -e "console.log(6*7)"' } });
  check("shell_run executes node", toolResult(shell).includes('"stdout":"42"') || toolResult(shell).includes("42"), toolResult(shell).slice(0, 300));

  // 5. shell guardrails — dangerous commands must be blocked
  console.log("\n[5] shell guardrails …");
  const blocked = await send("tools/call", { name: "shell_run", arguments: { command: "sudo rm -rf /" } });
  check("sudo blocked", toolResult(blocked).includes("blocked"), toolResult(blocked).slice(0, 200));
  const escape = await send("tools/call", { name: "shell_run", arguments: { command: "cat ../../etc/passwd" } });
  check("path escape blocked", toolResult(escape).includes("blocked") || toolResult(escape).includes("escape"), toolResult(escape).slice(0, 200));
  const fsEscape = await send("tools/call", { name: "fs_read", arguments: { path: "../package.json" } });
  check("fs_read sandbox blocks ../", toolResult(fsEscape).includes("escape"), toolResult(fsEscape).slice(0, 200));

  // 6. job-side tool still works
  console.log("\n[6] job tool (get_stats) …");
  const stats = await send("tools/call", { name: "get_stats", arguments: {} });
  check("get_stats responds", toolResult(stats).includes('"total"'), toolResult(stats).slice(0, 200));

  // 7. resources
  console.log("\n[7] resources …");
  const res = await send("resources/list", {});
  const uris = (res.result?.resources ?? []).map((r) => r.uri);
  check("resources/list exposes workspace files", uris.includes("workspace://handshake-test/hello.txt"), uris.slice(0, 5).join(","));

  const readRes = await send("resources/read", { uri: "workspace://handshake-test/hello.txt" });
  check("resources/read returns content", (readRes.result?.contents?.[0]?.text ?? "").includes("MCP v3 handshake EDITED"));

  // 8. workspace_info
  const ws = await send("tools/call", { name: "workspace_info", arguments: {} });
  check("workspace_info reports system resources", toolResult(ws).includes("cpuCores") && toolResult(ws).includes("totalMemoryMB"), toolResult(ws).slice(0, 200));
  check("workspace_info reports shell dialect", toolResult(ws).includes('"shell"') && toolResult(ws).includes('"kind"'), toolResult(ws).slice(0, 300));

  // 8b. agent_health — provider diagnostics
  console.log("\n[8b] agent_health …");
  const health = await send("tools/call", { name: "agent_health", arguments: {} });
  const healthText = toolResult(health);
  check("agent_health reports providers", healthText.includes('"providers"') && healthText.includes("gemini"), healthText.slice(0, 300));
  check("agent_health reports anyConfigured flag", healthText.includes("anyConfigured"), healthText.slice(0, 300));

  // 9. ping
  console.log("\n[8] ping …");
  const ping = await send("ping", {});
  check("ping → pong {}", JSON.stringify(ping.result) === "{}", JSON.stringify(ping.result));

  // 10. cleanup + audit log
  console.log("\n[9] cleanup + audit log …");
  const del = await send("tools/call", { name: "fs_delete", arguments: { path: "handshake-test" } });
  check("fs_delete ok", toolResult(del).replace(/\s+/g, "").includes('"deleted":true'), toolResult(del).slice(0, 200));

  await new Promise((r) => setTimeout(r, 300));
  try {
    await access(`${ROOT}workspace/.agent-shell/mcp-audit.log`);
    check("audit log written", true);
  } catch {
    check("audit log written", false, "workspace/.agent-shell/mcp-audit.log missing");
  }

  clearTimeout(overall);
  child.stdin.end();
  setTimeout(() => child.kill(), 500);

  console.log("\n──────────────────────────────");
  if (failures.length === 0) {
    console.log(`✅ MCP v3 HANDSHAKE: ALL CHECKS PASSED (${names.length} tools live)`);
    process.exit(0);
  } else {
    console.log(`❌ ${failures.length} FAILURE(S):\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
} catch (e) {
  console.error("TEST ERROR:", e);
  child.kill("SIGKILL");
  process.exit(1);
}
