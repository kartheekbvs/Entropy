// ─────────────────────────────────────────────────────────────
// REAL coding-agent E2E test. The agent must autonomously:
//   1. create workspace/demo-app with 4 files
//   2. start a Node server on port 4599 (background shell)
//   3. curl-verify it responds
// This script then INDEPENDENTLY verifies the live server and
// files, prints the agent's report, and cleans up the port.
//
// Run: bun scripts/test-coding-agent.ts
// ─────────────────────────────────────────────────────────────

// Set MCP_MODE first — silences prisma query-log spam on stdout
process.env.MCP_MODE = "1";

import { spawn, execSync } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";

const PORT = 4599;
const APP_DIR = path.resolve(process.cwd(), "workspace", "demo-app");

// 0. Ensure the port is free before we start
function freePort(): void {
  const cmds = [
    `ss -ltnp 2>/dev/null | grep :${PORT} | grep -oP 'pid=\\K[0-9]+' | xargs -r kill -9`,
    `lsof -ti:${PORT} 2>/dev/null | xargs -r kill -9`,
    `pkill -9 -f "demo-app/server.js" 2>/dev/null`,
  ];
  for (const c of cmds) {
    try {
      execSync(c, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}
freePort();

console.log("═".repeat(64));
console.log("CODING AGENT E2E — the agent builds and runs a REAL app");
console.log("═".repeat(64));

const GOAL = `Build a complete working web application in the workspace folder 'demo-app':
1. index.html — a clean portfolio page titled "Kartheek Agent Demo" (page <title> and an <h1> both contain that exact text), linking style.css and app.js
2. style.css — dark modern styling
3. app.js — sets the current year in the footer
4. server.js — a Node.js http server that serves the demo-app folder on 0.0.0.0:${PORT} with correct content-types
5. Start the server in the background (end the shell command with "&")
6. Verify with curl http://localhost:${PORT}/ that the HTML contains "Kartheek Agent Demo", and curl /style.css and /app.js return their content
7. IMPORTANT: LEAVE THE SERVER RUNNING when you finish — do NOT kill it at the end; it will be inspected after your run
8. Report the file tree, exact run instructions, and the verification output.`;

const { runCodingAgentToCompletion } = await import("../src/lib/agent/coding-runner");

const t0 = Date.now();
const out = await runCodingAgentToCompletion(GOAL);
const mins = ((Date.now() - t0) / 60000).toFixed(1);

console.log(`\nAgent finished in ${mins} min — status: ${out.status} · provider: ${out.provider || "n/a"}`);
console.log("\n── Step log ──");
for (const line of out.stepLog) console.log("  " + line);

console.log("\n── Agent final report ──");
console.log((out.result ?? "").slice(0, 2200));

// ── Independent verification ─────────────────────────────────
const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

console.log("\n── Independent verification ──");

// files
for (const f of ["index.html", "style.css", "app.js", "server.js"]) {
  try {
    await access(path.join(APP_DIR, f));
    check(`file exists: demo-app/${f}`, true);
  } catch {
    check(`file exists: demo-app/${f}`, false);
  }
}

// agent plan discipline (todo_write — Claude Code TodoWrite parity)
try {
  const st = await stat(path.resolve(process.cwd(), "workspace", ".agent-shell", "todos.json"));
  check("agent maintained a build plan (todos.json)", st.size > 0);
} catch {
  check("agent maintained a build plan (todos.json)", false);
}

// live server
async function httpGet(p: string): Promise<{ status: number; body: string } | null> {
  try {
    const res = await fetch(`http://localhost:${PORT}${p}`, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: (await res.text()).slice(0, 2000) };
  } catch {
    return null;
  }
}

const idx = await httpGet("/");
check("GET / responds (server is LIVE)", idx !== null, idx ? `status ${idx.status}` : "no response");
check("HTML contains 'Kartheek Agent Demo'", Boolean(idx?.body.includes("Kartheek Agent Demo")));

const css = await httpGet("/style.css");
check("GET /style.css serves CSS", css?.status === 200 && /font|background|color|:root|body/i.test(css?.body ?? ""), css?.body.slice(0, 60) ?? "");

const js = await httpGet("/app.js");
check("GET /app.js serves JS", js?.status === 200 && /getElementById|addEventListener|const |function |year/i.test(js?.body ?? ""), js?.body.slice(0, 60) ?? "");

// workspace stats
try {
  const files = await readdir(APP_DIR);
  console.log(`\n  demo-app contents: ${files.join(", ")}`);
} catch {
  /* already reported */
}

console.log("\n" + "═".repeat(64));
if (failures.length === 0 && out.status === "completed") {
  console.log("✅ CODING AGENT E2E PASSED — the agent built AND ran a real application");
} else {
  console.log(`❌ FAILED (${failures.length} verification failures · run status: ${out.status})`);
  process.exitCode = 1;
}

// cleanup: stop the server the agent started (leave files for inspection)
freePort();
process.exit(process.exitCode ?? 0);
