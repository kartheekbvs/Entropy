// v5.2 — E2E test: the offline engine through the REAL agent runner.
// Boots a SECOND server instance with AGENT_LLM_PROVIDER=offline — the
// exact state of a user's machine with no keys / no network (mode=offline
// skips the whole cloud chain). Verifies on the REAL stack:
//   1. a coding goal completes with provider "offline"
//   2. REAL files are created in workspace/app-*/
//   3. a job-agent goal gets a structured offline plan
//   4. the health route reports the offline engine + networkOnline
// Boots its own server on :3100, tears it down at the end.
import { spawn } from "node:child_process";

const BASE = "http://localhost:3100";
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  cond ? pass++ : fail++;
};

// ── boot the offline-mode server instance ─────────────────────
console.log("[boot] starting offline-mode server on :3100 ...");
const proc = spawn("node", ["scripts/server.js"], {
  cwd: "/home/z/my-project",
  env: {
    ...process.env,
    PORT: "3100",
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    AGENT_LLM_PROVIDER: "offline",
    ENTROPY_PROJECT_ROOT: "/home/z/my-project",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
try {
  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const c = await fetch(`${BASE}/api/agent/health`, { signal: AbortSignal.timeout(3000) });
      up = c.ok;
      if (up) break;
    } catch {}
  }
  ok("offline-mode server booted", up);
  if (!up) throw new Error("server never came up");

  // ── 1. health route: offline engine listed + networkOnline ──
  const h = await fetch(`${BASE}/api/agent/health`).then((r) => r.json());
  const providers: Array<{ name: string; configured: boolean; detail: string }> = h.agent?.providers ?? [];
  const offline = providers.find((p) => p.name === "offline");
  ok("health lists the offline engine", Boolean(offline?.configured));
  ok("health reports networkOnline", typeof h.agent?.networkOnline === "boolean");
  ok("mode reported as offline", h.agent?.mode === "offline");
  console.log(`       offline detail: ${offline?.detail?.slice(0, 90)}`);

  // ── 2. coding run in FORCED offline mode ──
  const t0 = Date.now();
  const runRes = await fetch(`${BASE}/api/agent/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "build a portfolio website for kartheek with dark theme",
      kind: "coding",
      mode: "manual",
    }),
  }).then((r) => r.json());
  const runId = runRes?.run?.id;
  ok("coding run accepted", Boolean(runId));

  let run: { status?: string; provider?: string; result?: string } = {};
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await fetch(`${BASE}/api/agent/run?id=${runId}`).then((r) => r.json());
    run = d?.run ?? {};
    if (run.status === "completed" || run.status === "failed") break;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`       run: status=${run.status} provider=${run.provider} in ${elapsed}s`);
  ok("coding run COMPLETED", run.status === "completed");
  ok("served by the offline engine", run.provider === "offline");
  ok("offline run is FAST (no timeout lag)", Date.now() - t0 < 60_000);
  ok("final report mentions the offline build", (run.result ?? "").includes("OFFLINE BUILD COMPLETE"));

  // ── 3. real files on disk? (folder parsed from the run's own report) ──
  const folder = (run.result ?? "").match(/OFFLINE BUILD COMPLETE \u2014 ([a-z0-9-]+)\//)?.[1] ?? "";
  ok("run report names its folder", folder.length > 4);
  const f = await fetch(
    `${BASE}/api/workspace/file?path=${folder}/index.html`
  ).then((r) => r.json());
  const content = (f?.content ?? "") as string;
  ok("index.html written with real content", content.includes("<!DOCTYPE html>") && content.length > 500);
  const css = await fetch(
    `${BASE}/api/workspace/file?path=${folder}/style.css`
  ).then((r) => r.json());
  ok("style.css written", ((css?.content ?? "") as string).includes("aurora"));
  const readme = await fetch(
    `${BASE}/api/workspace/file?path=${folder}/README.md`
  ).then((r) => r.json());
  ok("README.md written", ((readme?.content ?? "") as string).includes("Entropy Local Engine"));

  // ── 4. job-agent goal offline → structured plan ──
  const jobRes = await fetch(`${BASE}/api/agent/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ goal: "help me plan my job search this week", kind: "job", mode: "manual" }),
  }).then((r) => r.json());
  const jobId = jobRes?.run?.id;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const d = await fetch(`${BASE}/api/agent/run?id=${jobId}`).then((r) => r.json());
    run = d?.run ?? {};
    if (run.status === "completed" || run.status === "failed") break;
  }
  ok("job run completed offline", run.status === "completed");
  ok("job run returns the offline plan", (run.result ?? "").includes("JOB PLAN"));
} finally {
  proc.kill(9);
  console.log("[teardown] offline-mode server stopped");
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
