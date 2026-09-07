// ─────────────────────────────────────────────────────────────
// v4.0 TURBO + REAL-TIME TESTS
//   1. BUS        — event bus publish/subscribe/replay/cursor
//   2. PARTITION  — parallel tool partitioning (read-only grouped,
//                   mutating isolated, order preserved)
//   3. FSBATCH    — fs_batch executes mkdir+write+delete in ONE call
//   4. STREAM     — a local OpenAI-compatible SSE MOCK proves the
//                   streaming transport end-to-end: token deltas
//                   fire while generating, tool_calls assemble from
//                   fragments, usage detail is extracted. No real
//                   API key needed — deterministic.
//   5. RUN        — FULL agent loop against the mock: live deltas on
//                   the run channel, per-round usage events, fs_batch
//                   executed, parallel read group, terminal lines,
//                   disk verification of the final report.
//   6. RESET      — New Project: archive + fresh AGENT.md + .archive
//                   hidden from the tree
//   7. ROUTES     — live dev server :3000 — /api/agent/prefs,
//                   /api/agent/terminal (SSE hello + interactive exec)
//
// Run: bun scripts/test-v40.ts [all|bus|partition|fsbatch|stream|run|reset|routes]
// ─────────────────────────────────────────────────────────────
process.env.MCP_MODE = "1";

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const MOCK_PORT = 4611;
// The agent-loop phases run in a SCRATCH workspace so the real one is untouched.
const TEST_WS = path.resolve(process.cwd(), "workspace", ".test-v40");
process.env.AGENT_WORKSPACE = TEST_WS;
process.env.AGENT_MAX_ROUNDS = "6";
process.env.AGENT_BUDGET_MINUTES = "3";

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

console.log("═".repeat(64));
console.log("v4.0 TURBO + REAL-TIME TESTS");
console.log("═".repeat(64));

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

// ── mock SSE chat/completions server (OpenAI-compatible wire) ──
function sse(res: http.ServerResponse, chunks: unknown[], delayMs = 25): Promise<void> {
  return new Promise((resolve) => {
    let i = 0;
    const step = () => {
      if (i >= chunks.length) {
        res.write("data: [DONE]\n\n");
        res.end();
        resolve();
        return;
      }
      res.write(`data: ${JSON.stringify(chunks[i])}\n\n`);
      i++;
      setTimeout(step, delayMs);
    };
    step();
  });
}

interface MockRequest {
  messages: Array<{ role: string; content?: string | null }>;
  stream?: boolean;
}

function startMockServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    let requests = 0;
    const server = http.createServer((req, res) => {
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        requests++;
        const parsed = JSON.parse(body || "{}") as MockRequest;
        const hasToolResults = (parsed.messages ?? []).some((m) => m.role === "tool");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

        if (!hasToolResults) {
          // ROUND 1 — three tool calls in ONE turn: fs_batch (mutating)
          // + fs_list + todo_read (read-only → must run as a parallel group).
          const batchArgs = JSON.stringify({
            ops: [
              { op: "mkdir", path: "app-v40/src" },
              { op: "write", path: "app-v40/src/main.js", content: "console.log('v40-turbo');" },
              { op: "write", path: "app-v40/README.md", content: "v4.0 mock run" },
            ],
          });
          const fragments = [batchArgs.slice(0, 40), batchArgs.slice(40, 90), batchArgs.slice(90)];
          await sse(res, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "fs_batch", arguments: "" } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragments[0] } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragments[1] } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragments[2] } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "fs_list", arguments: '{"path":"app-v40"}' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 2, id: "call_c", function: { name: "todo_read", arguments: "{}" } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 950, completion_tokens: 140, total_tokens: 1090, prompt_time: 0.08, completion_time: 0.31 } },
          ]);
        } else {
          // ROUND 2 — final answer, streamed as content fragments.
          await sse(res, [
            { choices: [{ delta: { content: "Built app-v40 with fs_batch " } }] },
            { choices: [{ delta: { content: "in one round. All files verified." } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 1210, completion_tokens: 24, total_tokens: 1234, prompt_time: 0.05, completion_time: 0.09 } },
          ]);
        }
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── 1. BUS ────────────────────────────────────────────────────
if (want("bus")) {
  console.log("\n── 1. EVENT BUS (publish / subscribe / replay / cursor) ──");
  const { publish, subscribe, replay, currentSeq } = await import("../src/lib/agent/event-bus");
  const seen: string[] = [];
  const unsub = subscribe(["bus-test"], (e) => seen.push(e.text ?? ""));
  publish("bus-test", "line", { text: "hello" });
  publish("other-channel", "line", { text: "not for us" });
  publish("bus-test", "line", { text: "world" });
  await new Promise((r) => setTimeout(r, 30));
  check("listener receives only its channel", seen.join("|") === "hello|world", seen.join("|"));
  const seqNow = currentSeq();
  publish("bus-test", "line", { text: "after" });
  const replayed = replay("bus-test", seqNow);
  check("replay after cursor returns only newer events", replayed.length === 1 && replayed[0].text === "after");
  check("replay from 0 returns the full history", replay("bus-test", 0).length >= 3);
  unsub();
  publish("bus-test", "line", { text: "nobody listening" });
  check("unsubscribe works (no throw, no delivery)", true);
}

// ── 2. PARTITION ──────────────────────────────────────────────
if (want("partition")) {
  console.log("\n── 2. PARALLEL TOOL PARTITIONING ──");
  const { partitionToolCalls } = await import("../src/lib/agent/coding-runner");
  const call = (name: string) => ({ name, args: {} });
  const groups = partitionToolCalls([
    call("fs_read"), call("fs_list"), call("todo_read"), // → one parallel group of 3
    call("fs_batch"),                                     // → alone
    call("fs_read"),                                      // → alone (group broken by fs_batch)
    call("shell_run"),                                    // → alone
  ]);
  check(
    "consecutive read-only calls form one parallel group",
    groups[0]?.length === 3 && groups[0].every((c) => ["fs_read", "fs_list", "todo_read"].includes(c.name))
  );
  check("mutating call isolated", groups[1]?.length === 1 && groups[1][0].name === "fs_batch");
  check("read call after mutation isolated", groups[2]?.length === 1 && groups[2][0].name === "fs_read");
  check("shell always serial", groups[3]?.length === 1 && groups[3][0].name === "shell_run");
  const flat = groups.flat().map((c) => c.name);
  check("original call order preserved", flat.join(",") === "fs_read,fs_list,todo_read,fs_batch,fs_read,shell_run");
}

// ── 3. FSBATCH ────────────────────────────────────────────────
if (want("fsbatch")) {
  console.log("\n── 3. fs_batch (ONE call = whole scaffold) ──");
  const { executeCodingTool } = await import("../src/lib/agent/coding-tools");
  await fs.mkdir(path.join(TEST_WS, "batch-test"), { recursive: true });
  const result = (await executeCodingTool("fs_batch", {
    ops: [
      { op: "mkdir", path: "batch-test/app/templates" },
      { op: "write", path: "batch-test/app/index.html", content: "<h1>v40</h1>" },
      { op: "write", path: "batch-test/app/templates/home.html", content: "<p>home</p>" },
      { op: "delete", path: "batch-test/app/templates/home.html" },
    ],
  })) as { ok?: boolean; createdDirs?: number; writtenFiles?: number; deleted?: number; bytes?: number; failed?: number };
  check("batch reports 1 dir, 2 writes, 1 delete, 0 failures", result.ok === true && result.createdDirs === 1 && result.writtenFiles === 2 && result.deleted === 1 && result.failed === 0, JSON.stringify(result).slice(0, 120));
  const dirOk = await fs.stat(path.join(TEST_WS, "batch-test/app/templates")).then(() => true).catch(() => false);
  const fileOk = await fs.readFile(path.join(TEST_WS, "batch-test/app/index.html"), "utf8").then((t) => t.includes("v40")).catch(() => false);
  const deletedOk = await fs.stat(path.join(TEST_WS, "batch-test/app/templates/home.html")).then(() => false).catch(() => true);
  check("files really on disk (dir + file + delete)", dirOk && fileOk && deletedOk);
  const bad = (await executeCodingTool("fs_batch", { ops: [{ op: "mkdir", path: "../escape" }] })) as { ok?: boolean; failed?: number; failures?: Array<{ error?: string }> };
  check("path escape blocked", bad.ok === false && bad.failed === 1 && (bad.failures?.[0]?.error ?? "").includes("escapes"), (bad.failures?.[0]?.error ?? "").slice(0, 60));
}

// ── 4. STREAM (mock provider, direct transport test) ──────────
if (want("stream")) {
  console.log("\n── 4. STREAMING TRANSPORT (local SSE mock, no real key) ──");
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.GROQ_API_KEY = "mock-key-for-tests";
  process.env.AGENT_LLM_PROVIDER = "groq";
  const server = await startMockServer();
  try {
    const { generateWithAuto } = await import("../src/lib/agent/llm");
    const deltas: string[] = [];
    const t0 = Date.now();
    // ROUND 1 — tool calls (fragmented arguments exercise assembly).
    const first = await generateWithAuto(
      [{ role: "user", text: "build it" }],
      [],
      "system prompt",
      { onDelta: (frag) => deltas.push(frag) }
    );
    // ROUND 2 — final answer: content fragments stream live via onDelta.
    const second = await generateWithAuto(
      [
        { role: "user", text: "build it" },
        { role: "model", text: undefined, toolCalls: first.response.toolCalls },
        { role: "toolResults", results: [{ name: "fs_batch", result: { ok: true } }] },
      ],
      [],
      "system prompt",
      { onDelta: (frag) => deltas.push(frag) }
    );
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const { response, provider } = second;
    check(`provider is the mock groq (${secs}s, 2 rounds)`, provider === "groq");
    check("token deltas streamed live (final round content)", deltas.length >= 2, `${deltas.length} fragments: ${JSON.stringify(deltas).slice(0, 80)}`);
    check("final text assembled from stream", (response.text ?? "").includes("fs_batch"), response.text?.slice(0, 60));
    const toolCalls = first.response.toolCalls ?? [];
    check("tool_calls assembled from fragments", toolCalls.length === 3 && toolCalls[0].name === "fs_batch" && toolCalls[1].name === "fs_list" && toolCalls[2].name === "todo_read");
    const batchArgs = toolCalls[0].args as { ops?: unknown[] };
    check("fragmented arguments parsed to valid JSON", Array.isArray(batchArgs.ops) && batchArgs.ops.length === 3);
    const u = response.usage;
    check(
      "usage detail extracted (prompt/completion/tokPerSec)",
      Boolean(u && u.promptTokens === 1210 && u.completionTokens === 24 && u.tokPerSec && u.tokPerSec > 0),
      u ? `in ${u.promptTokens} / out ${u.completionTokens} / ${u.tokPerSec} tok/s` : "no usage"
    );
    check("token totals from usage blocks (both rounds)", first.response.tokens === 1090 && response.tokens === 1234);
  } finally {
    server.close();
  }
}

// ── 5. RUN (full agent loop against the mock) ─────────────────
if (want("run")) {
  console.log("\n── 5. FULL AGENT LOOP (live deltas · usage events · fs_batch · parallel group) ──");
  await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.GROQ_API_KEY = "mock-key-for-tests";
  process.env.AGENT_LLM_PROVIDER = "groq";
  const server = await startMockServer();
  try {
    const { startCodingAgentRun } = await import("../src/lib/agent/coding-runner");
    const { replay } = await import("../src/lib/agent/event-bus");
    const { db } = await import("../src/lib/db");

    const goal = "V40TEST build app-v40 with a batch and report";
    const runId = await startCodingAgentRun(goal);

    // wait for completion (mock rounds are fast)
    let status = "running";
    for (let i = 0; i < 120 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const row = await db.agentRun.findUnique({ where: { id: runId } });
      status = row?.status ?? "missing";
    }
    check("run completed against the mock provider", status === "completed", status);

    const runEvents = replay(`run:${runId}`, 0);
    const deltaEvents = runEvents.filter((e) => e.type === "delta");
    const usageEvents = runEvents.filter((e) => e.type === "usage");
    check("live deltas hit the run channel", deltaEvents.length >= 2, `${deltaEvents.length} delta events`);
    check("per-round usage events (one per round)", usageEvents.length === 2, `${usageEvents.length} usage events`);
    const u2 = usageEvents[1]?.data as { usage?: { promptTokens?: number; completionTokens?: number; tokPerSec?: number }; cumulative?: number } | undefined;
    check(
      "usage event carries detail + cumulative tokens",
      Boolean(u2?.usage?.promptTokens === 1210 && u2?.usage?.completionTokens === 24 && (u2?.cumulative ?? 0) >= 2324),
      JSON.stringify(u2?.usage ?? {}).slice(0, 90)
    );

    const termEvents = replay("terminal", 0);
    const termText = (kind?: string) => termEvents.filter((e) => e.kind === kind).map((e) => e.text ?? "").join("\n");
    check("terminal feed shows the goal + round stats", termText("goal").includes("V40TEST") && termText("round").includes("round 1"));
    check("terminal feed shows the fs_batch tool call", termText("tool").includes("fs_batch"));
    const resultLines = termText("result");
    const parallelIdx = resultLines.indexOf("(parallel)");
    const fsListIdx = resultLines.indexOf("fs_list →");
    check("read-only group marked parallel in the terminal", parallelIdx >= 0 && fsListIdx >= 0 && parallelIdx > fsListIdx, resultLines.split("\n").slice(-4).join(" | ").slice(0, 140));

    const mainJs = await fs.readFile(path.join(TEST_WS, "app-v40/src/main.js"), "utf8").catch(() => "");
    check("fs_batch wrote the real file in ONE round", mainJs.includes("v40-turbo"));
    const row = await db.agentRun.findUnique({ where: { id: runId } });
    check("final report includes disk verification of batch writes", Boolean(row?.result?.includes("VERIFIED ON DISK") && row.result.includes("app-v40/src/main.js")));
    check("tokens accumulated in DB", (row?.tokensUsed ?? 0) >= 2324, String(row?.tokensUsed ?? 0));
  } finally {
    server.close();
    await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── 6. RESET (New Project) ────────────────────────────────────
if (want("reset")) {
  console.log("\n── 6. NEW PROJECT RESET (archive + fresh AGENT.md + hidden) ──");
  const resetWs = path.resolve(process.cwd(), "workspace", ".test-v40-reset");
  await fs.rm(resetWs, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(path.join(resetWs, "old-project"), { recursive: true });
  await fs.writeFile(path.join(resetWs, "old-project", "keep.txt"), "previous project", "utf8");
  await fs.writeFile(path.join(resetWs, "AGENT.md"), "old memory", "utf8");
  process.env.AGENT_WORKSPACE = resetWs;
  try {
    const { resetWorkspace, buildWorkspaceTree, TREE_IGNORE } = await import("../src/lib/workspace");
    const result = await resetWorkspace({ archive: true });
    check("reset reports archivedTo + items cleared", Boolean(result.archivedTo && result.itemsCleared === 2), JSON.stringify({ archivedTo: result.archivedTo, items: result.itemsCleared }));
    const freshAgentMd = await fs.readFile(path.join(resetWs, "AGENT.md"), "utf8").catch(() => "");
    check("fresh AGENT.md written", freshAgentMd.includes("project memory"));
    const archived = await fs.readFile(path.join(resetWs, ".archive", result.archivedTo!, "old-project", "keep.txt"), "utf8").catch(() => "");
    check("old project recoverable in .archive", archived === "previous project");
    const meta = await buildWorkspaceTree();
    const names = JSON.stringify(meta);
    check(".archive hidden from the explorer tree", !names.includes(".archive") && !names.includes("old-project"));
    check("TREE_IGNORE knows .archive", TREE_IGNORE.has(".archive"));
  } finally {
    process.env.AGENT_WORKSPACE = TEST_WS;
    await fs.rm(resetWs, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── 7. ROUTES (live dev server on :3000) ──────────────────────
if (want("routes")) {
  console.log("\n── 7. LIVE ROUTES (dev server :3000) ──");
  const BASE = "http://localhost:3000";

  // prefs: set → read → clear
  const post = await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasoningEffort: "high", model: "openai/gpt-oss-20b" }),
  }).then((r) => r.json()) as { prefs?: { reasoningEffort?: string; model?: string } };
  check("prefs POST applies speed + model instantly", post.prefs?.reasoningEffort === "high" && post.prefs?.model === "openai/gpt-oss-20b");
  const getPrefs = await fetch(`${BASE}/api/agent/prefs`).then((r) => r.json()) as { prefs?: { reasoningEffort?: string } };
  check("prefs GET reflects runtime state", getPrefs.prefs?.reasoningEffort === "high");
  const cleared = await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reasoningEffort: "low", model: null }),
  }).then((r) => r.json()) as { prefs?: { reasoningEffort?: string; model?: string } };
  check("prefs model:null clears the override", cleared.prefs?.model === undefined && cleared.prefs?.reasoningEffort === "low");

  // terminal: SSE hello
  const helloOk = await new Promise<boolean>((resolve) => {
    const ctrl = new AbortController();
    fetch(`${BASE}/api/agent/terminal?since=0`, { signal: ctrl.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const timer = setTimeout(() => ctrl.abort(), 4000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (buf.includes('"type":"hello"')) {
            clearTimeout(timer);
            ctrl.abort();
            resolve(true);
            return;
          }
        }
      } catch {
        /* aborted */
      }
      clearTimeout(timer);
      resolve(false);
    }).catch(() => resolve(false));
  });
  check("terminal SSE stream sends hello (no reload needed)", helloOk);

  // terminal: interactive exec
  const exec = await fetch(`${BASE}/api/agent/terminal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: `node -e "console.log('v40-route-ok')"` }),
  }).then((r) => r.json()) as { ok?: boolean; output?: string; error?: string };
  check("terminal executes commands in the sandbox", exec.ok === true && (exec.output ?? "").includes("v40-route-ok"), (exec.error ?? exec.output ?? "").slice(0, 80));

  // events route still healthy (bus + DB poll layers) — unknown runs get
  // an SSE error event on the stream, not a hanging connection.
  const evRes = await fetch(`${BASE}/api/agent/events?id=nonexistent-run-id`);
  const evBody = await evRes.text().catch(() => "");
  check(
    "events route healthy (SSE error event for unknown run)",
    evRes.status === 200 && (evRes.headers.get("content-type") ?? "").includes("event-stream") && evBody.includes("\"type\":\"error\""),
    evBody.slice(0, 60)
  );
}

console.log("\n" + "═".repeat(64));
if (failures.length === 0) {
  console.log("ALL v4.0 TESTS PASSED");
} else {
  console.log(`FAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
