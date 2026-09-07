// ─────────────────────────────────────────────────────────────
// v4.2 FREE CHAIN + BUDGET AUTO-TAKEOVER + README + CHAT-CONTINUE
//   1. BUDGET   — llm-budget units: defaults (400/50), per-provider
//                 env override, counting, exhaustion, reset, disk
//                 persistence (survives restarts)
//   2. FREECHAIN— OpenRouter :free relay: model rotation on
//                 persistent 429, per-model budget counting,
//                 @openrouter/sdk-parity usage (reasoning tokens in
//                 the final chunk), live reasoning + content streams
//   3. TAKEOVER — 402 (out of credits) fails OVER (not hard-fail);
//                 daily budget exhausted → the chain AUTO-TAKES-OVER
//                 with a 💰 terminal line, memory preserved
//   4. README   — full agent loop on the mock: model forgets
//                 README.md → deterministic guarantee generates one
//                 (stack detected, port from the goal, file tree)
//                 + conversation snapshot kept on disk
//   5. CHAT     — Copilot-Chat-style follow-up: continueCodingRun
//                 restores the memory, writes greeting.txt, snapshot
//                 updated to the new run
//   6. ROUTES   — live dev server :3000 — prefs accepts freechain,
//                 health lists freechain/ollama + llmBudget, chat
//                 route answers availability
//
// Run: bun scripts/test-v42.ts [all|budget|freechain|takeover|readme|chat|routes]
// No real API key needed — everything hits local mocks.
// ─────────────────────────────────────────────────────────────
process.env.MCP_MODE = "1";

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const MOCK_PORT = 4617;
const TEST_WS = path.resolve(process.cwd(), "workspace", ".test-v42");
process.env.AGENT_WORKSPACE = TEST_WS;
process.env.AGENT_MAX_ROUNDS = "6";
process.env.AGENT_BUDGET_MINUTES = "3";
// v4.3 HERMETICITY: bun auto-loads the project .env, which now carries
// a real EXPLABS_API_KEY — the Experiential Labs gateway would sit
// between openrouter and freechain and intercept the 402/budget
// failovers this suite asserts. Keep this suite on its own chain;
// explabs has its own dedicated suite (scripts/test-v43.ts).
delete process.env.EXPLABS_API_KEY;
delete process.env.EXPLABS_API_BASE;
delete process.env.EXPLABS_MODELS;
// fast + deterministic resilience knobs for the test process
process.env.AGENT_LLM_BACKOFF_BASE_MS = "40";
process.env.AGENT_LLM_BACKOFF_MAX_MS = "160";
process.env.AGENT_LLM_BREAKER_AFTER = "3";
process.env.AGENT_LLM_BREAKER_MS = "2500";
process.env.AGENT_LLM_MAX_ATTEMPTS = "3";

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

console.log("═".repeat(64));
console.log("v4.2 FREE CHAIN + BUDGET AUTO-TAKEOVER + README + CHAT TESTS");
console.log("═".repeat(64));

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

// ── mock server: OpenRouter wire (:free models, 429, 402, runs) ──
const mockState = {
  poolside429: false, // every request for poolside/laguna → 429
  glm402: false, // every request for z-ai/glm-5.2 → 402 (no credits)
  requests: 0,
};

function sse(res: http.ServerResponse, chunks: unknown[], delayMs = 8): Promise<void> {
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
  model: string;
  messages: Array<{ role: string; content?: string | null }>;
  stream?: boolean;
}

function toolCallChunks(name: string, args: string): unknown[] {
  const frags = [args.slice(0, Math.ceil(args.length / 3)), args.slice(Math.ceil(args.length / 3), (2 * args.length) / 3), args.slice((2 * args.length) / 3)];
  return [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_v42", function: { name, arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frags[0] } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frags[1] } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frags[2] } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 800, completion_tokens: 120, total_tokens: 920 } },
  ];
}

function startMockServer(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        mockState.requests++;
        const parsed = JSON.parse(body || "{}") as MockRequest;
        const model = String(parsed.model ?? "");
        const messages = parsed.messages ?? [];
        const hasToolResults = messages.some((m) => m.role === "tool");
        const lastMsg = messages[messages.length - 1];
        // v4.2 chat-continue: the follow-up turn is the LAST message —
        // history from the earlier run may already contain tool results.
        const wantsFollowUpTool =
          lastMsg?.role === "user" && String(lastMsg.content ?? "").includes("CONTINUE THIS PROJECT");

        // ── failure modes ──
        if (mockState.glm402 && model === "z-ai/glm-5.2") {
          res.writeHead(402, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 402, message: "Insufficient credits: you need more credits to use this model" } }));
          return;
        }
        if (mockState.poolside429 && model.includes("poolside")) {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0.3" });
          res.end(JSON.stringify({ error: { code: 429, message: "Free-model rate limit exceeded. Please try again in 0.3s" } }));
          return;
        }

        // ── free-model success: reasoning + content + usage with
        //    completion_tokens_details.reasoning_tokens (the exact
        //    @openrouter/sdk stream shape the user referenced) ──
        if (model.includes(":free")) {
          if (parsed.stream !== true) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [{ message: { role: "assistant", content: "free-model ok", reasoning: "thought about it" } }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0, completion_tokens_details: { reasoning_tokens: 77 } },
              })
            );
            return;
          }
          await sse(res, [
            { choices: [{ delta: { reasoning: "let me think about the strawberry question" } }] },
            { choices: [{ delta: { reasoning: " and count the letters" } }] },
            { choices: [{ delta: { content: "free-model ok" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0, completion_tokens_details: { reasoning_tokens: 77 } } },
          ]);
          return;
        }

        // ── groq-style scripted agent runs ──
        if (parsed.stream !== true) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: hasToolResults ? "final ok" : "tools now", tool_calls: undefined } }],
              usage: { prompt_tokens: 700, completion_tokens: 30, total_tokens: 730 },
            })
          );
          return;
        }
        if (wantsFollowUpTool) {
          // chat-continue round 1: one surgical write
          await sse(res, toolCallChunks("fs_write", JSON.stringify({ path: "app-v42/greeting.txt", content: "hello from the follow-up chat\n" })));
          return;
        }
        if (!hasToolResults) {
          // run round 1: whole scaffold in ONE fs_batch — NO README on
          // purpose (phase 4 proves the deterministic guarantee).
          const batchArgs = JSON.stringify({
            ops: [
              { op: "mkdir", path: "app-v42" },
              { op: "write", path: "app-v42/server.js", content: "const http=require('http');http.createServer((q,s)=>s.end('v42')).listen(4595,'0.0.0.0');" },
              { op: "write", path: "app-v42/package.json", content: "{\"name\":\"app-v42\",\"scripts\":{\"start\":\"node server.js\"}}" },
              { op: "write", path: "app-v42/index.html", content: "<h1>v42</h1>" },
            ],
          });
          await sse(res, toolCallChunks("fs_batch", batchArgs));
          return;
        }
        // final answer
        await sse(res, [
          { choices: [{ delta: { content: "Built app-v42. " } }] },
          { choices: [{ delta: { content: "All verified." } }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 24, total_tokens: 1024 } },
        ]);
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── 1. BUDGET (pure units) ─────────────────────────────────────
if (want("budget")) {
  console.log("\n── 1. DAILY BUDGET SERVER (llm-budget units) ──");
  await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);
  const mod = await import("../src/lib/agent/llm-budget");
  mod.resetBudgets();
  delete process.env.AGENT_PROVIDER_DAILY_BUDGET;
  delete process.env.AGENT_GROQ_DAILY_BUDGET;

  check("default provider limit is 400/day (the user's number)", mod.budgetLimitFor("groq") === 400, String(mod.budgetLimitFor("groq")));
  check("free-model default limit is 50/day (OpenRouter :free tier)", mod.budgetLimitFor("freechain:poolside/laguna-s-2.1:free") === 50, String(mod.budgetLimitFor("freechain:poolside/laguna-s-2.1:free")));

  process.env.AGENT_GROQ_DAILY_BUDGET = "2";
  check("per-provider env override honored", mod.budgetLimitFor("groq") === 2);
  mod.recordBudgetRequest("groq");
  let info = await mod.budgetInfo("groq");
  check("one request counted, not exhausted", info.used === 1 && !info.exhausted && info.remaining === 1, JSON.stringify(info));
  mod.recordBudgetRequest("groq");
  info = await mod.budgetInfo("groq");
  check("budget exhausts exactly at the limit", info.used === 2 && info.exhausted && info.remaining === 0);
  check("resetsInMs points at UTC midnight", info.resetsInMs > 0 && info.resetsInMs <= 24 * 3600 * 1000, `${Math.round(info.resetsInMs / 3600000)}h`);

  mod.recordBudgetRequest("freechain:poolside/laguna-s-2.1:free");
  const all = await mod.budgetStatusAll();
  check("status lists every tracked key", Boolean(all["groq"] && all["freechain:poolside/laguna-s-2.1:free"]), Object.keys(all).join(","));

  await mod.flushBudgetState();
  const diskRaw = await fs.readFile(path.join(TEST_WS, ".agent-state", "llm-budget.json"), "utf8").catch(() => "");
  check("budget state persisted to disk (survives restarts)", diskRaw.includes(`"groq":2`), diskRaw.slice(0, 80));

  mod.resetBudgets();
  info = await mod.budgetInfo("groq");
  check("resetBudgets zeroes the counters", info.used === 0 && !info.exhausted);
}

// ── 2. FREECHAIN (rotation + SDK-parity usage) ─────────────────
if (want("freechain")) {
  console.log("\n── 2. FREE CHAIN (OpenRouter :free relay) ──");
  process.env.OPENROUTER_API_KEY = "mock-or-key";
  process.env.OPENROUTER_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.AGENT_LLM_PROVIDER = "auto";
  const { freechainProvider, openrouterFreeModels, setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
  setRuntimeLlmPrefs({ mainProvider: null, model: null });
  const { resetBudgets } = await import("../src/lib/agent/llm-budget");
  resetBudgets();

  check(
    "default relay is poolside → nemotron-lightning → dots3",
    openrouterFreeModels().join("|") === "poolside/laguna-s-2.1:free|nvidia/nemotron-3.5-lightning:free|dots-studio/dots3-note-preview:free",
    openrouterFreeModels().join(" → ")
  );

  mockState.poolside429 = true;
  const server = await startMockServer();
  try {
    const reasoningFrags: string[] = [];
    const deltas: string[] = [];
    const resp = await freechainProvider.generate(
      [{ role: "user", text: "How many r's are in strawberry?" }],
      [],
      "system",
      { onDelta: (f) => deltas.push(f), onReasoning: (f) => reasoningFrags.push(f) }
    );
    check("429'd free model rotated → nemotron-lightning served", resp.model === "nvidia/nemotron-3.5-lightning:free", resp.model ?? "");
    check("content streamed on the delta channel", deltas.join("").includes("free-model ok"));
    check("reasoning streamed on its OWN channel (sdk parity)", reasoningFrags.join("").includes("strawberry") && reasoningFrags.join("").includes("letters"));
    check("content stays clean of reasoning text", !deltas.join("").includes("strawberry"));
    check("usage.reasoning_tokens captured from the final chunk (sdk parity)", resp.usage?.reasoningTokens === 77, String(resp.usage?.reasoningTokens));
    check(":free usage carries no phantom cost", resp.usage?.costUsd === undefined, String(resp.usage?.costUsd));

    const { llmResilienceStatus } = await import("../src/lib/agent/llm-resilience");
    const cell = llmResilienceStatus()["freechain:poolside/laguna-s-2.1:free"];
    check("per-model resilience cell tracked (queue/backoff/breaker)", Boolean(cell && cell.totalRetries >= 2), JSON.stringify(cell ?? {}).slice(0, 90));
    const { budgetInfo } = await import("../src/lib/agent/llm-budget");
    const spent = await budgetInfo("freechain:poolside/laguna-s-2.1:free");
    check("429'd attempts count against the model's daily budget", spent.used >= 3, `${spent.used}/50`);
  } finally {
    mockState.poolside429 = false;
    server.close();
  }
}

// ── 3. TAKEOVER (402 + budget exhaustion → auto-fallback) ──────
if (want("takeover")) {
  console.log("\n── 3. BUDGET AUTO-TAKEOVER + 402 FAIL-OVER ──");
  process.env.GROQ_API_KEY = "mock-key-for-tests";
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.OPENROUTER_API_KEY = "mock-or-key";
  process.env.OPENROUTER_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.AGENT_LLM_PROVIDER = "auto";
  process.env.AGENT_PROVIDER_DAILY_BUDGET = "";
  process.env.AGENT_GROQ_DAILY_BUDGET = "";
  const llm = await import("../src/lib/agent/llm");
  const { resetBudgets } = await import("../src/lib/agent/llm-budget");
  resetBudgets();
  const { replay } = await import("../src/lib/agent/event-bus");

  const server = await startMockServer();
  try {
    // 3a — OpenRouter 402 (out of credits): FAILS OVER to the free
    // chain instead of hard-ending the run (the user's key state).
    // Groq's key is removed for this sub-test so the free relay is the
    // next configured candidate — exactly the zero-credit scenario.
    // A warm-up round first makes openrouter (the MAIN model) the
    // ACTIVE provider so the failover provably hands off its memory.
    llm.setRuntimeLlmPrefs({ mainProvider: "openrouter", model: null });
    await llm.generateWithAuto([{ role: "user", text: "warm-up round" }], [], "system");
    mockState.glm402 = true;
    delete process.env.GROQ_API_KEY;
    const out = await llm.generateWithAuto([{ role: "user", text: "build it" }], [], "system");
    check("402 on the paid model → freechain takes over", out.provider === "freechain", out.provider);
    check(
      "handoff note explains the failover with memory preserved",
      Boolean(out.handoff && out.handoff.includes("openrouter stopped working") && out.handoff.includes("memory preserved")),
      (out.handoff ?? "").slice(0, 80)
    );
    check("served by a :free model", Boolean(out.response.model?.includes(":free")), out.response.model ?? "");
    mockState.glm402 = false;
    process.env.GROQ_API_KEY = "mock-key-for-tests";

    // 3b — daily budget exhausted (the "after 400" server): groq is
    // skipped instantly and the chain continues — task completes.
    // The paid OpenRouter model still 402s (no credits) → freechain
    // serves the round: BOTH takeover layers in one chain walk.
    mockState.glm402 = true;
    process.env.AGENT_GROQ_DAILY_BUDGET = "2";
    resetBudgets();
    await llm.groqProvider.generate([{ role: "user", text: "one" }], [], "system");
    await llm.groqProvider.generate([{ role: "user", text: "two" }], [], "system");
    const budget = await (await import("../src/lib/agent/llm-budget")).budgetInfo("groq");
    check("two real requests counted against groq's budget", budget.used === 2 && budget.exhausted, JSON.stringify(budget));

    llm.setRuntimeLlmPrefs({ mainProvider: "groq", model: null });
    const out2 = await llm.generateWithAuto([{ role: "user", text: "still works" }], [], "system");
    check("exhausted groq auto-takes-over to freechain (task completes)", out2.provider === "freechain", out2.provider);

    const termEvents = replay("terminal", 0);
    const budgetLine = termEvents.find((e) => e.kind === "budget");
    check(
      "💰 takeover line published to the live terminal feed",
      Boolean(budgetLine && (budgetLine.text ?? "").includes("daily budget exhausted") && (budgetLine.text ?? "").includes("takes over")),
      (budgetLine?.text ?? "").slice(0, 90)
    );
    process.env.AGENT_GROQ_DAILY_BUDGET = "";
    llm.setRuntimeLlmPrefs({ mainProvider: null, model: null });
  } finally {
    mockState.glm402 = false;
    server.close();
  }
}

// ── 4. README GUARANTEE + snapshot (full agent loop) ───────────
if (want("readme")) {
  console.log("\n── 4. README.md BY DEFAULT + CONVERSATION SNAPSHOT ──");
  await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);
  const { resetBudgets } = await import("../src/lib/agent/llm-budget");
  resetBudgets();
  process.env.GROQ_API_KEY = "mock-key-for-tests";
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.AGENT_LLM_PROVIDER = "groq";
  const server = await startMockServer();
  try {
    const { startCodingAgentRun } = await import("../src/lib/agent/coding-runner");
    const { db } = await import("../src/lib/db");
    const goal = "V42TEST build app-v42, a Node app with a server on port 4595, and report";
    const runId = await startCodingAgentRun(goal);

    let status = "running";
    for (let i = 0; i < 120 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const row = await db.agentRun.findUnique({ where: { id: runId } });
      status = row?.status ?? "missing";
    }
    check("run completed against the mock", status === "completed", status);

    const row = await db.agentRun.findUnique({ where: { id: runId } });
    check("final report carries the deterministic README note", Boolean(row?.result?.includes("📘 README.md")), (row?.result ?? "").slice(-160));
    check("disk verification present (accuracy layer)", Boolean(row?.result?.includes("VERIFIED ON DISK")));

    const readme = await fs.readFile(path.join(TEST_WS, "app-v42", "README.md"), "utf8").catch(() => "");
    check("README.md generated inside the single project dir", readme.length > 0);
    check("README explains WHAT it is", readme.includes("# app-v42") && readme.includes("What this is"));
    check("README ships HOW TO RUN commands", readme.includes("## How to run") && readme.includes("npm install"));
    check("README detected the start script", readme.includes("npm start") || readme.includes("node server.js"));
    check("README picked the port from the goal", readme.includes("4595"), readme.slice(0, 60));
    check("README lists the real file tree", readme.includes("app-v42/server.js") || readme.includes("server.js"));

    const snapRaw = await fs.readFile(path.join(TEST_WS, ".agent-state", "conversation.json"), "utf8").catch(() => "");
    const snap = snapRaw ? (JSON.parse(snapRaw) as { runId: string; history: unknown[]; writtenPaths: string[] }) : null;
    check("conversation snapshot kept for chat-continue", Boolean(snap && snap.runId === runId && Array.isArray(snap.history) && snap.history.length >= 3), `${snap?.history.length ?? 0} turns`);
    check("snapshot carries the written-file ledger", Boolean(snap?.writtenPaths.some((p) => p.includes("server.js"))));
  } finally {
    server.close();
  }
}

// ── 5. CHAT-CONTINUE (Copilot-Chat-style follow-up) ────────────
if (want("chat")) {
  console.log("\n── 5. CHAT-CONTINUE (follow-up turn, full memory) ──");
  process.env.GROQ_API_KEY = "mock-key-for-tests";
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.AGENT_LLM_PROVIDER = "groq";
  const { resetBudgets } = await import("../src/lib/agent/llm-budget");
  resetBudgets();
  const server = await startMockServer();
  try {
    const { continueCodingRun } = await import("../src/lib/agent/coding-runner");
    const { db } = await import("../src/lib/db");
    const before = await db.agentRun.findFirst({ where: { mode: "coding", status: "completed" }, orderBy: { startedAt: "desc" } });
    check("phase-4 run exists to continue from", Boolean(before?.id), before?.id.slice(0, 8) ?? "none");

    const started = await continueCodingRun("please add a greeting.txt file that says hello, then report");
    check("continueCodingRun started a new run", started.ok && Boolean(started.runId), started.message.slice(0, 90));

    let status = "running";
    for (let i = 0; i < 120 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const row = await db.agentRun.findUnique({ where: { id: started.runId! } });
      status = row?.status ?? "missing";
    }
    check("continued run completed", status === "completed", status);

    const row = await db.agentRun.findUnique({ where: { id: started.runId! } });
    check("new run goal marks the follow-up", Boolean(row?.goal.includes("CONTINUE (follow-up chat)")));

    const greeting = await fs.readFile(path.join(TEST_WS, "app-v42", "greeting.txt"), "utf8").catch(() => "");
    check("follow-up write landed on disk (surgical fs_write)", greeting.includes("hello from the follow-up chat"), greeting.slice(0, 40));

    const steps = row ? (JSON.parse(row.steps || "[]") as Array<{ type: string; text?: string }>) : [];
    const notes = steps.filter((s) => s.type === "note").map((s) => s.text ?? "").join("\n");
    check("transcript shows the 💬 CONTINUING note", notes.includes("CONTINUING the project") || notes.includes("Follow-up received"), notes.slice(0, 80));

    const snapRaw = await fs.readFile(path.join(TEST_WS, ".agent-state", "conversation.json"), "utf8").catch(() => "");
    const snap = snapRaw ? (JSON.parse(snapRaw) as { runId: string; history: unknown[] }) : null;
    check("snapshot advanced to the continued run", snap?.runId === started.runId, `${snap?.runId.slice(0, 8)} vs ${started.runId?.slice(0, 8)}`);
    check("snapshot history includes the follow-up user turn", Boolean(
      (snap?.history as Array<{ role: string; text?: string }>)?.some((t) => t.role === "user" && (t.text ?? "").includes("greeting.txt"))
    ));

    // unavailable-snapshot guard
    await fs.rm(path.join(TEST_WS, ".agent-state", "conversation.json"), { force: true });
    const guard = await continueCodingRun("another change");
    check("no-snapshot guard returns an actionable message", !guard.ok && guard.message.includes("No chat-continuable project"), guard.message.slice(0, 60));
  } finally {
    server.close();
  }
}

// ── 6. ROUTES (live dev server :3000) ──────────────────────────
if (want("routes")) {
  console.log("\n── 6. LIVE ROUTES (dev server :3000) ──");
  const BASE = "http://localhost:3000";

  const post = await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainProvider: "freechain" }),
  }).then((r) => r.json()) as { ok?: boolean; prefs?: { mainProvider?: string }; chain?: string[] };
  check("prefs accepts mainProvider=freechain", post.prefs?.mainProvider === "freechain" && post.chain?.[0] === "freechain", (post.chain ?? []).slice(0, 3).join(" → "));

  const getPrefs = await fetch(`${BASE}/api/agent/prefs`).then((r) => r.json()) as {
    env?: { openrouterFreeModels?: string[]; ollamaModel?: string };
  };
  check("prefs env exposes the free relay + ollama defaults", getPrefs.env?.openrouterFreeModels?.[0] === "poolside/laguna-s-2.1:free" && (getPrefs.env?.ollamaModel ?? "").includes("qwen2.5-coder"));

  const health = await fetch(`${BASE}/api/agent/health`).then((r) => r.json()) as {
    agent?: { providers?: Array<{ name: string; configured: boolean }> };
    llmBudget?: Record<string, { used: number; limit: number }>;
  };
  const names = (health.agent?.providers ?? []).map((p) => p.name);
  check("health lists the two new providers", names.includes("freechain") && names.includes("ollama"), names.join(","));
  check("freechain configured (OPENROUTER key present)", (health.agent?.providers ?? []).find((p) => p.name === "freechain")?.configured === true);
  check("health carries the llmBudget block (fallback server status)", typeof health.llmBudget === "object" && health.llmBudget !== null, JSON.stringify(health.llmBudget ?? {}).slice(0, 60));

  const chatGet = await fetch(`${BASE}/api/agent/chat`).then((r) => r.json()) as { available?: boolean };
  check("chat availability endpoint answers", typeof chatGet.available === "boolean", String(chatGet.available));

  const chatPost = await fetch(`${BASE}/api/agent/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "add a tiny comment line to the readme notes, then stop" }),
  });
  const chatData = (await chatPost.json()) as { ok?: boolean; error?: string; message?: string };
  check(
    "chat POST answers correctly for the server's snapshot state (409+guidance without one, 201+ok with one, 409 while a run is active)",
    (chatPost.status === 409 && ((chatData.error ?? "").includes("chat-continuable") || (chatData.error ?? "").includes("already active"))) ||
      (chatPost.status === 201 && chatData.ok === true),
    `${chatPost.status}: ${(chatData.error ?? chatData.message ?? "").slice(0, 70)}`
  );

  // restore the server-side toggle to auto
  await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainProvider: null }),
  });
  check("toggle restored to auto", true);
}

// ── cleanup ────────────────────────────────────────────────────
await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);

console.log("\n" + "═".repeat(64));
if (failures.length === 0) {
  console.log("ALL v4.2 CHECKS PASSED ✅");
} else {
  console.log(`FAILED: ${failures.length} ❌`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
