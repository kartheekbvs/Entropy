// ─────────────────────────────────────────────────────────────
// v4.1 MODEL TOGGLE + QUEUING/BACKOFF TESTS
//   1. BACKOFF   — tenacity-style unit tests: exponential-jitter
//                  bounds, Retry-After override + give-up threshold,
//                  breaker open/half-open/close, queue serialization
//   2. SSE-ERR   — NVIDIA's real failure mode (HTTP 200 + error
//                  INSIDE the stream) is detected and retried
//   3. REASONING — NIM reasoning_content + OpenRouter reasoning
//                  deltas parse on their own channel; usage carries
//                  reasoning tokens + USD cost; NIM params exact
//   4. TOGGLE    — provider registry: main model first, unkeyed
//                  main skipped, forced env modes
//   5. RUN       — FULL agent loop against an OpenRouter-style
//                  mock: reasoning events on the run channel, usage
//                  with model + cost, fs_batch executed, disk verify
//   6. ROUTES    — live dev server :3000 — prefs mainProvider
//                  toggle + health (new providers + llmQueue)
//
// Run: bun scripts/test-v41.ts [all|backoff|sseerr|reasoning|toggle|run|routes]
// No real API key needed — everything hits local mocks.
// ─────────────────────────────────────────────────────────────
process.env.MCP_MODE = "1";

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const MOCK_PORT = 4613;
const TEST_WS = path.resolve(process.cwd(), "workspace", ".test-v41");
process.env.AGENT_WORKSPACE = TEST_WS;
process.env.AGENT_MAX_ROUNDS = "6";
process.env.AGENT_BUDGET_MINUTES = "3";
// v4.3 HERMETICITY: keep the Experiential Labs gateway (real key in
// the auto-loaded project .env) out of this suite's chain — explabs
// has its own dedicated suite (scripts/test-v43.ts).
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
console.log("v4.1 MODEL TOGGLE + QUEUING/BACKOFF TESTS");
console.log("═".repeat(64));

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

// ── mock server: OpenRouter-wire + NVIDIA-wire + failure modes ──
type MockMode = "ok" | "sse-error" | "http-429";
const mockState = { mode: "ok" as MockMode, requests: 0 };
const seenBodies: Array<Record<string, unknown>> = [];
const seenHeaders: Array<Record<string, string>> = [];

function sse(res: http.ServerResponse, chunks: unknown[], delayMs = 10): Promise<void> {
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
        const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
        seenBodies.push(parsed);
        seenHeaders.push(req.headers as Record<string, string>);
        const model = String(parsed.model ?? "");

        if (mockState.mode === "sse-error") {
          // One-shot: the first attempt fails, the retry must succeed.
          mockState.mode = "ok";
          // The VERIFIED live NVIDIA failure: HTTP 200, error in stream.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ error: { message: "Service temporarily overloaded", code: 503 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (mockState.mode === "http-429") {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "0.3" });
          res.end(JSON.stringify({ error: { message: "Rate limit reached. Please try again in 0.3s" } }));
          return;
        }

        // Non-streaming callers get a normal JSON body (the transport
        // only streams when the caller passes onDelta).
        if (parsed.stream !== true) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "ok",
                    reasoning: "brief thought",
                    tool_calls: model.includes("nemotron")
                      ? undefined
                      : [{ id: "call_ns", type: "function", function: { name: "todo_read", arguments: "{}" } }],
                  },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.000004 },
            })
          );
          return;
        }

        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const messages = (parsed.messages ?? []) as Array<{ role: string }>;
        const hasToolResults = messages.some((m) => m.role === "tool");

        if (model.includes("nemotron")) {
          // NVIDIA NIM wire: reasoning_content channel + reference params.
          await sse(res, [
            { choices: [{ delta: { role: "assistant", reasoning_content: "The user wants" } }] },
            { choices: [{ delta: { reasoning_content: " a tool call with x=5" } }] },
            { choices: [{ delta: { content: "Calling the tool now." } }] },
            { choices: [{ delta: { content: " Done." } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 300, completion_tokens: 60, total_tokens: 360, completion_tokens_details: { reasoning_tokens: 42 } } },
          ]);
        } else if (!hasToolResults) {
          // OpenRouter GLM-5.2 wire, round 1: reasoning + tool_calls.
          const batchArgs = JSON.stringify({
            ops: [
              { op: "mkdir", path: "app-v41/src" },
              { op: "write", path: "app-v41/src/main.js", content: "console.log('v41-toggle');" },
            ],
          });
          await sse(res, [
            { choices: [{ delta: { role: "assistant", reasoning: "I will scaffold app-v41" } }] },
            { choices: [{ delta: { reasoning: " using one fs_batch call." } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_or1", function: { name: "fs_batch", arguments: batchArgs } }] } }] },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
            { choices: [], usage: { prompt_tokens: 950, completion_tokens: 140, total_tokens: 1090, prompt_tokens_details: { cached_tokens: 104 }, completion_tokens_details: { reasoning_tokens: 22 }, cost: 0.0000340648 } },
          ]);
        } else {
          // Round 2 — final answer + full usage detail.
          await sse(res, [
            { choices: [{ delta: { content: "Built app-v41 via fs_batch in one round. " } }] },
            { choices: [{ delta: { content: "Verified." } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 1210, completion_tokens: 24, total_tokens: 1234, prompt_tokens_details: { cached_tokens: 132 }, completion_tokens_details: { reasoning_tokens: 6 }, cost: 0.000093936 } },
          ]);
        }
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── 1. BACKOFF (unit, no network) ─────────────────────────────
if (want("backoff")) {
  console.log("\n── 1. QUEUING & BACKOFF (tenacity semantics) ──");
  const { backoffDelayMs, withLlmResilience, LlmCircuitOpenError, llmResilienceStatus, isTransientError } =
    await import("../src/lib/agent/llm-resilience");

  // exponential bounds with full jitter
  const d1 = backoffDelayMs(1);
  const d2 = backoffDelayMs(2);
  check("attempt 1 delay ∈ [base/2, base]", d1 >= 20 && d1 <= 40, `${d1}ms`);
  check("attempt 2 delay ∈ [base, 2·base]", d2 >= 40 && d2 <= 80, `${d2}ms`);
  check("attempt caps at backoff max", backoffDelayMs(9) <= 160);

  // Retry-After overrides the curve; > 45s trips give-up (-1)
  check("retry-after is honored exactly", backoffDelayMs(1, 700) === 700);
  check("retry-after < 250ms floors at 250", backoffDelayMs(1, 5) === 250);
  check("retry-after > 45s → give up (-1)", backoffDelayMs(1, 46_000) === -1);

  // transient classification
  check("stream-error is transient", isTransientError(new Error("stream-error: HTTP 503: overloaded")));
  check("hard 400 is NOT transient", !isTransientError(new Error("HTTP 400: bad request")));

  // retry-then-succeed
  let calls = 0;
  const resets: number[] = [];
  const out = await withLlmResilience("retry-test", async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("stream-error: HTTP 503: overloaded"), {});
    return "ok";
  }, { onRetry: (n) => { resets.push(n.attempt); } });
  check("retries then succeeds", out === "ok" && calls === 3, `calls=${calls}`);
  check("onRetry fired before each wait", resets.length === 2, JSON.stringify(resets));
  check("breaker stays closed after success", llmResilienceStatus()["retry-test"]?.breaker === "closed");

  // Retry-After honored end-to-end (429 with a 300ms server demand —
  // shaped like a real ProviderUnavailableError with retryAfterMs)
  const t0 = Date.now();
  let calls429 = 0;
  await withLlmResilience("retry-after-test", async () => {
    calls429++;
    if (calls429 === 1) {
      throw Object.assign(new Error("HTTP 429: rate limit"), {
        provider: "retry-after-test",
        name: "ProviderUnavailableError",
        retryAfterMs: 300,
      });
    }
    return "ok";
  });
  const waited = Date.now() - t0;
  check("server-demanded wait (300ms) actually waited", waited >= 290 && calls429 === 2, `${waited}ms`);

  // circuit breaker: 3 consecutive exhausted calls open it
  const failAlways = async () => {
    throw new Error("stream-error: HTTP 503: overloaded");
  };
  for (let i = 0; i < 3; i++) {
    await withLlmResilience("breaker-test", failAlways).catch(() => undefined);
  }
  check("breaker OPEN after 3 consecutive failures", llmResilienceStatus()["breaker-test"]?.breaker === "open");
  let breakerFast = false;
  try {
    await withLlmResilience("breaker-test", async () => "never-called");
  } catch (e) {
    breakerFast = e instanceof LlmCircuitOpenError;
  }
  check("open breaker skips the provider instantly (LlmCircuitOpenError)", breakerFast);
  // after the cooldown the breaker goes half-open; a successful probe
  // re-closes it (this is the correct lifecycle — no instant reopen)
  await new Promise((r) => setTimeout(r, 2600));
  await withLlmResilience("breaker-test", async () => "ok").catch(() => undefined);
  check("a success after the cooldown re-closes the breaker", llmResilienceStatus()["breaker-test"]?.breaker === "closed");

  // per-provider queue serializes concurrent calls (fair FIFO)
  const order: string[] = [];
  const job = (name: string, ms: number) =>
    withLlmResilience("queue-test", async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}:end`);
      return name;
    });
  const [a, b, c] = await Promise.all([job("a", 80), job("b", 30), job("c", 10)]);
  check("queue returns every job's value", a === "a" && b === "b" && c === "c");
  const aStart = order.indexOf("a:start");
  const aEnd = order.indexOf("a:end");
  const bStart = order.indexOf("b:start");
  check("second request waits for the first (serial slot)", aEnd < bStart, order.join(","));
}

// ── 2. SSE-ERR (the verified NVIDIA failure mode) ─────────────
if (want("sseerr")) {
  console.log("\n── 2. MID-STREAM SSE ERROR → DETECTED + RETRIED ──");
  process.env.AGENT_LLM_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "mock-key-for-tests";
  process.env.OPENROUTER_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  const server = await startMockServer();
  try {
    mockState.mode = "sse-error";
    const { openrouterProvider } = await import("../src/lib/agent/llm");
    let resets = 0;
    const deltas: string[] = [];
    const resp = await openrouterProvider.generate(
      [{ role: "user", text: "test" }],
      [],
      "system",
      { onDelta: (f) => deltas.push(f), onReset: () => resets++, }
    );
    check("SSE-embedded 503 was retried and answered", (resp.text ?? "").includes("Done") || resp.toolCalls !== undefined, JSON.stringify(resp.text ?? "").slice(0, 40));
    check("onReset cleared the partial live text on retry", resets >= 1, `resets=${resets}`);
    check("mock saw the failed attempt + the retry", mockState.requests === 2, `requests=${mockState.requests}`);
  } finally {
    mockState.mode = "ok";
    mockState.requests = 0;
    server.close();
  }
}

// ── 3. REASONING (NIM + OpenRouter wire formats) ──────────────
if (want("reasoning")) {
  console.log("\n── 3. REASONING STREAMS + EXACT NIM PARAMS + COST ──");
  process.env.AGENT_LLM_PROVIDER = "nvidia";
  process.env.NVIDIA_API_KEY = "mock-nv-key";
  process.env.NVIDIA_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  const server = await startMockServer();
  try {
    const { nvidiaProvider, setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
    setRuntimeLlmPrefs({ reasoningEffort: null, mainProvider: null, model: null });

    const reasoningFrags: string[] = [];
    const deltas: string[] = [];
    const resp = await nvidiaProvider.generate(
      [{ role: "user", text: "call the tool" }],
      [],
      "system",
      {
        onDelta: (f) => deltas.push(f),
        onReasoning: (f) => reasoningFrags.push(f),
      }
    );
    check("NIM reasoning_content streamed on its own channel", reasoningFrags.join("").includes("tool call with x=5"), reasoningFrags.join("").slice(0, 50));
    check("content stays clean of reasoning text", deltas.join("").includes("Calling the tool now") && !deltas.join("").includes("x=5"));
    check("reasoningText reported on the response", (resp.reasoningText ?? "").includes("tool call with x=5"));
    check("model id carried on the response", resp.model === "nvidia/nemotron-3-ultra-550b-a55b");
    check("usage carries reasoning tokens", resp.usage?.reasoningTokens === 42, String(resp.usage?.reasoningTokens));
    check("no phantom cost when the provider sends none", resp.usage?.costUsd === undefined);

    const nimBody = seenBodies[seenBodies.length - 1];
    check("NIM reference params exact: temperature 1", nimBody.temperature === 1);
    check("NIM reference params exact: top_p 0.95", nimBody.top_p === 0.95);
    check("NIM reference params exact: chat_template_kwargs.enable_thinking", Boolean((nimBody.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking === true));
    check("NIM requests stream usage (stream_options)", Boolean((nimBody.stream_options as Record<string, unknown> | undefined)?.include_usage === true));

    // Turbo (low effort) turns thinking OFF
    setRuntimeLlmPrefs({ reasoningEffort: "low" });
    await nvidiaProvider.generate([{ role: "user", text: "again" }], [], "system").catch(() => undefined);
    const nimBody2 = seenBodies[seenBodies.length - 1];
    check("Turbo (low) disables enable_thinking for speed", (nimBody2.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking === false);
    setRuntimeLlmPrefs({ reasoningEffort: null });
  } finally {
    server.close();
  }
}

// ── 4. TOGGLE (provider registry + main-model selection) ──────
if (want("toggle")) {
  console.log("\n── 4. MAIN-MODEL TOGGLE (registry order + failover) ──");
  process.env.AGENT_LLM_PROVIDER = "auto";
  process.env.GROQ_API_KEY = "mock-groq-key";
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.OPENROUTER_API_KEY = "mock-or-key";
  process.env.OPENROUTER_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.NVIDIA_API_KEY = "mock-nv-key";
  process.env.NVIDIA_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  const server = await startMockServer();
  try {
    const { generateWithAuto, providerChainOrder, setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
    setRuntimeLlmPrefs({ mainProvider: null, model: null, reasoningEffort: null });

    const defaultOrder = providerChainOrder();
    check("default registry order starts with groq", defaultOrder[0] === "groq" && defaultOrder.includes("openrouter") && defaultOrder.includes("nvidia"));

    setRuntimeLlmPrefs({ mainProvider: "openrouter" });
    const orOrder = providerChainOrder();
    check("toggle puts the selected MAIN first", orOrder[0] === "openrouter" && orOrder[1] === "groq");
    const r1 = await generateWithAuto([{ role: "user", text: "hi" }], [], "sys");
    check("chain RUNS on the selected main model", r1.provider === "openrouter");
    const orBody = seenBodies[seenBodies.length - 1];
    check("OpenRouter reasoning effort mapped from speed selector", (orBody.reasoning as Record<string, unknown> | undefined)?.effort !== undefined);
    const orHeaders = seenHeaders[seenHeaders.length - 1];
    check("OpenRouter attribution headers sent", orHeaders["http-referer"] !== undefined && (orHeaders["x-title"] ?? "") === "Job Command Center");

    setRuntimeLlmPrefs({ mainProvider: "nvidia" });
    const r2 = await generateWithAuto([{ role: "user", text: "hi" }], [], "sys");
    check("toggle to NVIDIA runs on nvidia", r2.provider === "nvidia");

    // selected main WITHOUT a key → skipped, falls to groq (failover)
    setRuntimeLlmPrefs({ mainProvider: "glm" });
    const r3 = await generateWithAuto([{ role: "user", text: "hi" }], [], "sys");
    check("unkeyed main is skipped and the chain falls through", r3.provider === "groq", r3.provider);

    // forced env mode
    process.env.AGENT_LLM_PROVIDER = "openrouter";
    const r4 = await generateWithAuto([{ role: "user", text: "hi" }], [], "sys");
    check("AGENT_LLM_PROVIDER=openrouter forced mode", r4.provider === "openrouter");
    process.env.AGENT_LLM_PROVIDER = "auto";
    setRuntimeLlmPrefs({ mainProvider: null });
  } finally {
    server.close();
  }
}

// ── 5. RUN (full agent loop on the OpenRouter mock) ───────────
if (want("run")) {
  console.log("\n── 5. FULL AGENT LOOP (GLM-5.2 wire · reasoning events · $ meter) ──");
  await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);
  process.env.AGENT_LLM_PROVIDER = "openrouter";
  process.env.OPENROUTER_API_KEY = "mock-key-for-tests";
  process.env.OPENROUTER_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.GROQ_API_KEY = "";
  const server = await startMockServer();
  try {
    const { startCodingAgentRun } = await import("../src/lib/agent/coding-runner");
    const { replay } = await import("../src/lib/agent/event-bus");
    const { db } = await import("../src/lib/db");
    const { setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
    setRuntimeLlmPrefs({ mainProvider: "openrouter", model: null, reasoningEffort: null });

    const goal = "V41TEST build app-v41 with GLM-5.2 and report";
    const runId = await startCodingAgentRun(goal);

    let status = "running";
    for (let i = 0; i < 120 && status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const row = await db.agentRun.findUnique({ where: { id: runId } });
      status = row?.status ?? "missing";
    }
    check("run completed on the OpenRouter (GLM-5.2) mock", status === "completed", status);

    const runEvents = replay(`run:${runId}`, 0);
    const reasoningEvents = runEvents.filter((e) => e.type === "reasoning");
    const usageEvents = runEvents.filter((e) => e.type === "usage");
    check("chain-of-thought streamed live on the run channel", reasoningEvents.length >= 1, `${reasoningEvents.length} reasoning events`);
    const u1 = usageEvents[0]?.data as { model?: string; usage?: { costUsd?: number; reasoningTokens?: number; cachedTokens?: number }; provider?: string } | undefined;
    check("usage event carries the model id", u1?.model === "z-ai/glm-5.2", String(u1?.model));
    check("usage event carries USD cost + reasoning + cached tokens", Boolean(u1?.usage?.costUsd === 0.000034 && u1?.usage?.reasoningTokens === 22 && u1?.usage?.cachedTokens === 104), JSON.stringify(u1?.usage ?? {}).slice(0, 110));

    const termEvents = replay("terminal", 0);
    const termText = (kind?: string) => termEvents.filter((e) => e.kind === kind).map((e) => e.text ?? "").join("\n");
    check("round note shows model + $ cost in the terminal", termText("round").includes("z-ai/glm-5.2") && termText("round").includes("$"), termText("round").split("\n")[0]?.slice(0, 110));
    check("reasoning summary line in the terminal feed", termText("note").includes("reasoning"));

    const mainJs = await fs.readFile(path.join(TEST_WS, "app-v41/src/main.js"), "utf8").catch(() => "");
    check("fs_batch wrote the real file through the GLM-5.2 round", mainJs.includes("v41-toggle"));
    const row = await db.agentRun.findUnique({ where: { id: runId } });
    check("provider chain recorded in the run row", (row?.provider ?? "").includes("openrouter"), String(row?.provider));
    setRuntimeLlmPrefs({ mainProvider: null });
  } finally {
    server.close();
    await fs.rm(TEST_WS, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── 6. ROUTES (live dev server :3000) ─────────────────────────
if (want("routes")) {
  console.log("\n── 6. LIVE ROUTES (prefs mainProvider toggle + health) ──");
  const BASE = "http://localhost:3000";

  const post = await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainProvider: "openrouter" }),
  }).then((r) => r.json()) as { prefs?: { mainProvider?: string }; chain?: string[] };
  check("prefs POST mainProvider re-orders the chain", post.prefs?.mainProvider === "openrouter" && post.chain?.[0] === "openrouter", JSON.stringify(post.chain ?? []).slice(0, 80));

  const getPrefs = await fetch(`${BASE}/api/agent/prefs`).then((r) => r.json()) as { prefs?: { mainProvider?: string }; chain?: string[] };
  check("prefs GET reflects the toggle", getPrefs.prefs?.mainProvider === "openrouter");

  const health = await fetch(`${BASE}/api/agent/health`).then((r) => r.json()) as {
    agent?: { providers?: Array<{ name: string; configured: boolean }> };
    llmQueue?: Record<string, unknown>;
  };
  const providers = health.agent?.providers ?? [];
  const or = providers.find((p) => p.name === "openrouter");
  const nv = providers.find((p) => p.name === "nvidia");
  check("health lists OpenRouter configured", Boolean(or?.configured), JSON.stringify(or ?? {}).slice(0, 80));
  check("health lists NVIDIA configured", Boolean(nv?.configured), JSON.stringify(nv ?? {}).slice(0, 80));
  check("health exposes the live llm queue state", typeof health.llmQueue === "object" && health.llmQueue !== null);

  const cleared = await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainProvider: null }),
  }).then((r) => r.json()) as { prefs?: { mainProvider?: string }; chain?: string[] };
  check("prefs mainProvider:null restores the default chain", cleared.prefs?.mainProvider === undefined && cleared.chain?.[0] === "groq");
}

console.log("\n" + "═".repeat(64));
if (failures.length === 0) {
  console.log(`✅ ALL v4.1 CHECKS PASSED${PHASE === "all" ? " (all phases)" : ` (${PHASE})`}`);
} else {
  console.log(`❌ ${failures.length} FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exitCode = 1;
}
