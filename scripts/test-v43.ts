// ─────────────────────────────────────────────────────────────
// v4.3 EXPERIENTIAL LABS GATEWAY — provider + model-bar tests
//   1. UNITS   — explabsModels() parsing/env/runtime override,
//                chain order (explabs main → front), -free budget
//   2. GATEWAY — mock /v1/chat/completions: 403 geo-wall rotation,
//                invalid_parameter → minimal-body retry, streaming
//                tool calls assembled, usage (reasoning + $cost),
//                per-model budget counting, all-fail diagnosis
//   3. CHAIN   — forced mode; MAIN=explabs hands off to groq with
//                the memory-preserved note when every slug walls
//   4. LIVE    — the REAL gateway (owner's xpl_ key, minimax-
//                m2.7-free, $0): streaming round + usage parsed
//                (skippable: EXPLABS_LIVE=0)
//   5. ROUTES  — dev server :3000 — prefs accepts explabs, chain
//                re-orders, health lists it configured
//
// Run: bun scripts/test-v43.ts [all|units|gateway|chain|live|routes]
// Mock phases need no real key; the live phase reads .env.
// ─────────────────────────────────────────────────────────────
process.env.MCP_MODE = "1";

import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

const MOCK_PORT = 4619;
const TEST_WS = path.resolve(process.cwd(), "workspace", ".test-v43");
process.env.AGENT_WORKSPACE = TEST_WS;
process.env.AGENT_MAX_ROUNDS = "6";
process.env.AGENT_BUDGET_MINUTES = "3";
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
console.log("v4.3 EXPERIENTIAL LABS GATEWAY TESTS");
console.log("═".repeat(64));

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

// ── mock gateway (Experiential Labs wire) ─────────────────────
// Implements the VERIFIED live behaviors:
//   • 403 {"error":{"code":"model_location_not_supported"}} — the
//     geo wall paid OpenAI/Anthropic slugs answer from some regions
//   • 400 {"error":{"code":"invalid_parameter","param":"max_tokens"}}
//     — a model that caps output tokens; minimal body succeeds
//   • 429 unavailable_route + Retry-After: 5 — transient throttle
//   • SSE stream: tool_calls deltas + final-chunk usage with
//     completion_tokens_details.reasoning_tokens + cost (exact shape
//     captured from api.experientiallabs.ai on the owner's key)
const mockState = {
  geo403: false, // minimax-m2.7-free → 403 model_location_not_supported
  pinAlways400: false, // pinned-sampler → 400 even on the minimal body
  throttleOnce: 0, // serve-ok: one 429 Retry-After first
  sawMinimalBody: false, // a request arrived WITHOUT max_tokens
  modelHits: {} as Record<string, number>,
};

interface MockRequest {
  model: string;
  messages: Array<{ role: string; content?: string | null }>;
  stream?: boolean;
  max_tokens?: number;
  stream_options?: unknown;
}

function sse(res: http.ServerResponse, chunks: unknown[], delayMs = 6): Promise<void> {
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

function errPayload(res: http.ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
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
        const parsed = JSON.parse(body || "{}") as MockRequest;
        const model = String(parsed.model ?? "");
        mockState.modelHits[model] = (mockState.modelHits[model] ?? 0) + 1;
        if (parsed.max_tokens === undefined) mockState.sawMinimalBody = true;

        // ── model-level walls ──
        if (mockState.geo403 && model === "minimax-m2.7-free") {
          errPayload(res, 403, {
            error: {
              message: "This model is unavailable from the request's location, or we could not verify an eligible location.",
              type: "api_error",
              code: "model_location_not_supported",
            },
          });
          return;
        }
        if (model === "pinned-sampler") {
          if (parsed.max_tokens !== undefined) {
            // full body → the model pins its output cap
            errPayload(res, 400, {
              error: { message: "max_tokens must be at most 1024 for this model", type: "invalid_request_error", code: "invalid_parameter", param: "max_tokens" },
            });
            return;
          }
          if (mockState.pinAlways400) {
            errPayload(res, 400, {
              error: { message: "max_tokens must be at most 1024 for this model", type: "invalid_request_error", code: "invalid_parameter", param: "max_tokens" },
            });
            return;
          }
          // minimal body → serves (the recovery path works)
          if (parsed.stream !== true) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                choices: [{ message: { role: "assistant", content: "pinned ok" } }],
                usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, cost: 0 },
              })
            );
            return;
          }
          await sse(res, [
            { choices: [{ delta: { content: "pinned ok" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }] },
            { choices: [], usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46, cost: 0 } },
          ]);
          return;
        }

        // ── serve-ok: one transient 429 with Retry-After, then SSE ──
        if (model === "serve-ok" && mockState.throttleOnce > 0) {
          mockState.throttleOnce -= 1;
          errPayload(
            res,
            429,
            { error: { message: "provider throttled the request; retry after the delay in the Retry-After header", type: "api_error", code: "unavailable_route" } },
            { "retry-after": "0.2" }
          );
          return;
        }

        // ── success: streaming tool call + final-chunk usage (the
        //    exact shape captured live from minimax-m2.7-free) ──
        const args = JSON.stringify({ path: "demo" });
        if (parsed.stream !== true) {
          // non-streaming callers (generateWithAuto without onDelta)
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "final ok" } }],
              usage: { prompt_tokens: 90, completion_tokens: 8, total_tokens: 98 },
            })
          );
          return;
        }
        await sse(res, [
          { choices: [{ delta: { reasoning: "checking the folder name" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_function_946p5um7pg6e_1", function: { name: "fs_mkdir", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 6) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(6) } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 201, completion_tokens: 49, total_tokens: 250, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 19 }, cost: 0.000029 } },
        ]);
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── 1. UNITS (pure) ───────────────────────────────────────────
if (want("units")) {
  console.log("\n── 1. EXPLABS UNITS (models / chain / budget) ──");
  const { explabsModels, providerChainOrder, setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
  setRuntimeLlmPrefs({ mainProvider: null, model: null });
  delete process.env.EXPLABS_MODELS;

  const def = explabsModels();
  check(
    "default waterfall is minimax-free → kimi → glm → qwen (all verified live)",
    def.join("|") === "minimax-m2.7-free|kimi-k2.6|glm-5.2|qwen3.6-flash",
    def.join(" → ")
  );

  process.env.EXPLABS_MODELS = " claude-sonnet-5 , gpt-5.2 , ,glm-5.2 ";
  check("env override parsed (trim + drop empties, dupes kept as-is)", explabsModels().join("|") === "claude-sonnet-5|gpt-5.2|glm-5.2", explabsModels().join(" → "));
  delete process.env.EXPLABS_MODELS;

  setRuntimeLlmPrefs({ mainProvider: "explabs", model: "deepseek-v4-pro" });
  check("runtime model override prepends when Ex Labs is MAIN", explabsModels()[0] === "deepseek-v4-pro" && explabsModels().length === 5, explabsModels().join(" → "));
  setRuntimeLlmPrefs({ mainProvider: "glm", model: "deepseek-v4-pro" });
  check("override ignored when Ex Labs is NOT the main (groq parity)", explabsModels()[0] === "minimax-m2.7-free");
  setRuntimeLlmPrefs({ mainProvider: null, model: null });

  const order = providerChainOrder();
  check("default chain slots explabs after openrouter (before freechain)", order[0] === "groq" && order[1] === "openrouter" && order[2] === "explabs" && order[3] === "freechain", order.slice(0, 5).join(" → "));
  setRuntimeLlmPrefs({ mainProvider: "explabs" });
  check("MAIN=explabs moves to the front of the chain", providerChainOrder()[0] === "explabs" && providerChainOrder()[1] === "groq");
  setRuntimeLlmPrefs({ mainProvider: null, model: null });

  const { budgetLimitFor } = await import("../src/lib/agent/llm-budget");
  check("-free slug gets the protective 50/day limit", budgetLimitFor("explabs:minimax-m2.7-free") === 50, String(budgetLimitFor("explabs:minimax-m2.7-free")));
  check("paid slug gets the standard 400/day limit", budgetLimitFor("explabs:kimi-k2.6") === 400, String(budgetLimitFor("explabs:kimi-k2.6")));
}

// ── 2. GATEWAY (mock wire behaviors) ──────────────────────────
if (want("gateway")) {
  console.log("\n── 2. GATEWAY WIRE (rotation / recovery / streaming) ──");
  process.env.EXPLABS_API_KEY = "xpl_mockkey_mockkey_mockkey_mockkey_mockkey";
  process.env.EXPLABS_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.EXPLABS_MODELS = "minimax-m2.7-free,pinned-sampler";
  process.env.AGENT_LLM_PROVIDER = "auto";
  const { explabsProvider, setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
  setRuntimeLlmPrefs({ mainProvider: null, model: null });
  const { resetBudgets } = await import("../src/lib/agent/llm-budget");
  resetBudgets();

  const server = await startMockServer();
  try {
    // 2a — geo wall on the first model → rotation to pinned-sampler,
    // which 400s invalid_parameter on the full body and serves on the
    // MINIMAL body: both recovery layers in one walk.
    mockState.geo403 = true;
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const resp = await explabsProvider.generate(
      [{ role: "user", text: "Create a folder named demo" }],
      [],
      "system",
      { onDelta: (f) => deltas.push(f), onReasoning: (f) => reasoning.push(f) }
    );
    check("403 geo wall rotated to the next gateway model", resp.model === "pinned-sampler", resp.model ?? "");
    check("invalid_parameter → minimal-body retry served (no max_tokens sent)", mockState.sawMinimalBody);
    check("content streamed on the delta channel", deltas.join("").includes("pinned ok"));
    check("geo-wall model was attempted (retries) before rotating", (mockState.modelHits["minimax-m2.7-free"] ?? 0) >= 3, `${mockState.modelHits["minimax-m2.7-free"] ?? 0} hits`);
    mockState.geo403 = false;

    // 2b — the serve-ok model: streaming tool calls + final-chunk usage
    process.env.EXPLABS_MODELS = "serve-ok";
    mockState.throttleOnce = 1;
    const resets: number[] = [];
    const resp2 = await explabsProvider.generate(
      [{ role: "user", text: "Create a folder named demo via the tool" }],
      [{ name: "fs_mkdir", description: "Create a directory", parameters: { type: "object", properties: { path: { type: "string", description: "directory to create" } }, required: ["path"] }, execute: async () => ({ ok: true }) }],
      "system",
      { onDelta: () => undefined, onReasoning: (f) => reasoning.push(f), onReset: () => resets.push(1) }
    );
    check("429 unavailable_route (Retry-After honored) retried, not rotated", resp2.model === "serve-ok" && (mockState.modelHits["serve-ok"] ?? 0) >= 2, `${mockState.modelHits["serve-ok"] ?? 0} hits`);
    check("onReset fired when the throttle restarted generation", resets.length >= 1, `${resets.length} resets`);
    check("streamed tool_calls fragments assembled into one call", resp2.toolCalls?.[0]?.name === "fs_mkdir" && resp2.toolCalls?.[0]?.args?.path === "demo", JSON.stringify(resp2.toolCalls?.[0] ?? {}).slice(0, 80));
    check("usage.reasoning_tokens captured from the final chunk (19)", resp2.usage?.reasoningTokens === 19, String(resp2.usage?.reasoningTokens));
    check("usage.cost (USD) captured from the final chunk", resp2.usage?.costUsd === 0.000029, String(resp2.usage?.costUsd));
    check("reasoning channel separate from content", reasoning.join("").includes("folder name"));
    check("prompt/completion tokens metered", resp2.usage?.promptTokens === 201 && resp2.usage?.completionTokens === 49, `${resp2.usage?.promptTokens}/${resp2.usage?.completionTokens}`);

    const { budgetInfo } = await import("../src/lib/agent/llm-budget");
    const spentFree = await budgetInfo("explabs:minimax-m2.7-free");
    const spentOk = await budgetInfo("explabs:serve-ok");
    check("attempts counted against each model's daily budget", spentFree.used >= 3 && spentOk.used >= 2, `minimax ${spentFree.used} · serve-ok ${spentOk.used}`);

    const { llmResilienceStatus } = await import("../src/lib/agent/llm-resilience");
    const cell = llmResilienceStatus()["explabs:serve-ok"];
    check("per-model resilience cell tracked (queue/backoff/breaker)", Boolean(cell && cell.totalRetries >= 1), JSON.stringify(cell ?? {}).slice(0, 90));

    // 2c — every model walls → ProviderUnavailableError with the
    // per-model diagnosis (the chain then takes over)
    process.env.EXPLABS_MODELS = "minimax-m2.7-free,pinned-sampler";
    mockState.geo403 = true;
    mockState.pinAlways400 = true;
    let diagnose = "";
    try {
      await explabsProvider.generate([{ role: "user", text: "anything" }], [], "system");
    } catch (e) {
      diagnose = (e as Error).message ?? "";
    }
    check("all-models-failed → per-model diagnosis (rotatable, not hard)", diagnose.includes("every Experiential Labs model failed") && diagnose.includes("minimax-m2.7-free") && diagnose.includes("pinned-sampler"), diagnose.slice(0, 110));
    mockState.geo403 = false;
    mockState.pinAlways400 = false;
  } finally {
    server.close();
  }
}

// ── 3. CHAIN (forced mode + failover with memory) ─────────────
if (want("chain")) {
  console.log("\n── 3. PROVIDER CHAIN (forced explabs + handoff) ──");
  process.env.EXPLABS_API_KEY = "xpl_mockkey_mockkey_mockkey_mockkey_mockkey";
  process.env.EXPLABS_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.EXPLABS_MODELS = "minimax-m2.7-free,pinned-sampler";
  process.env.GROQ_API_KEY = "mock-groq-for-v43";
  process.env.GROQ_API_BASE = `http://127.0.0.1:${MOCK_PORT}`;
  process.env.AGENT_LLM_PROVIDER = "auto";
  const llm = await import("../src/lib/agent/llm");
  const { resetBudgets } = await import("../src/lib/agent/llm-budget");
  resetBudgets();
  llm.setRuntimeLlmPrefs({ mainProvider: null, model: null });

  const server = await startMockServer();
  // the mock serves explabs models on the same port; anything else
  // falls to the groq-style default handler below
  try {
    // 3a — MAIN=explabs, warm round served by the gateway (geo off)
    llm.setRuntimeLlmPrefs({ mainProvider: "explabs" });
    const warm = await llm.generateWithAuto([{ role: "user", text: "warm-up" }], [], "system");
    check("MAIN=explabs round served by the gateway", warm.provider === "explabs" && warm.response.model === "minimax-m2.7-free", `${warm.provider} · ${warm.response.model ?? ""}`);

    // 3b — the whole gateway walls (geo + pinned) → groq takes over
    // with the memory-preserved handoff note
    mockState.geo403 = true;
    mockState.pinAlways400 = true;
    const out = await llm.generateWithAuto([{ role: "user", text: "keep building" }], [], "system");
    check("every gateway model walled → groq took over", out.provider === "groq", out.provider);
    check(
      "handoff note: memory preserved across the provider switch",
      Boolean(out.handoff && out.handoff.includes("explabs stopped working") && out.handoff.includes("memory preserved")),
      (out.handoff ?? "").slice(0, 90)
    );
    mockState.geo403 = false;
    mockState.pinAlways400 = false;

    // 3c — forced mode AGENT_LLM_PROVIDER=explabs
    process.env.AGENT_LLM_PROVIDER = "explabs";
    const forced = await llm.generateWithAuto([{ role: "user", text: "forced" }], [], "system");
    check("AGENT_LLM_PROVIDER=explabs forced round served by the gateway", forced.provider === "explabs", forced.provider);
    process.env.AGENT_LLM_PROVIDER = "auto";
    llm.setRuntimeLlmPrefs({ mainProvider: null, model: null });

    // 3d — the no-provider message tells the user exactly how to fix
    // a missing explabs key (fresh-install convention)
    delete process.env.EXPLABS_API_KEY;
    const msg = llm.buildNoProviderMessage("explabs");
    check("no-key message names EXPLABS_API_KEY + where to mint one", msg.includes("EXPLABS_API_KEY") && msg.includes("platform.experientiallabs.ai"), msg.slice(0, 100));
    const health = await llm.getProviderHealth();
    const xpl = health.providers.find((p) => p.name === "explabs");
    check("health: unconfigured explabs carries the actionable hint", xpl?.configured === false && (xpl?.hint ?? "").includes("313 models"), (xpl?.detail ?? "").slice(0, 60));
    process.env.EXPLABS_API_KEY = "xpl_mockkey_mockkey_mockkey_mockkey_mockkey";
  } finally {
    server.close();
  }
}

// ── 4. LIVE (the real gateway, owner's key, $0 model) ─────────
if (want("live")) {
  console.log("\n── 4. LIVE GATEWAY (api.experientiallabs.ai · minimax-m2.7-free) ──");
  // bun auto-loads .env; the live phase must point at the REAL gateway
  delete process.env.EXPLABS_API_BASE;
  delete process.env.EXPLABS_MODELS;
  // earlier mock phases may have overwritten the key — re-read the REAL
  // one from the project .env so the live probe uses the owner's key
  const envRaw = await fs.readFile(path.join(process.cwd(), ".env"), "utf8").catch(() => "");
  const envKey = /^EXPLABS_API_KEY=(.+)$/m.exec(envRaw)?.[1]?.trim() ?? "";
  if (envKey) process.env.EXPLABS_API_KEY = envKey;
  const key = process.env.EXPLABS_API_KEY ?? "";
  if (process.env.EXPLABS_LIVE === "0" || !key.startsWith("xpl_")) {
    check("live phase skipped (EXPLABS_LIVE=0 or no xpl_ key in .env)", true);
  } else {
    const { explabsProvider, explabsModels, setRuntimeLlmPrefs } = await import("../src/lib/agent/llm");
    setRuntimeLlmPrefs({ mainProvider: null, model: null });
    const { resetBudgets } = await import("../src/lib/agent/llm-budget");
    resetBudgets();
    check("waterfall resolved from .env (minimax first)", explabsModels()[0] === "minimax-m2.7-free", explabsModels().join(" → "));

    const deltas: string[] = [];
    let settled: { model?: string; text?: string; usage?: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number } } = {};
    try {
      const resp = await Promise.race([
        explabsProvider.generate([{ role: "user", text: "Reply with exactly: gateway ok" }], [], "You are a health probe. Be terse.", { onDelta: (f) => deltas.push(f) }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("live gateway timeout after 120s")), 120_000)),
      ]);
      settled = resp;
      check("live round served by the free gateway model", resp.model === "minimax-m2.7-free", resp.model ?? "");
      check("live answer produced (content or reasoning, cost $0)", Boolean(resp.text || resp.reasoningText), JSON.stringify(resp.text ?? "").slice(0, 60));
      check("live usage metered (final-chunk usage block)", (resp.usage?.promptTokens ?? 0) > 0 && (resp.usage?.completionTokens ?? 0) > 0, `${resp.usage?.promptTokens}/${resp.usage?.completionTokens} tok`);
      check("live stream delivered token deltas", deltas.length > 0, `${deltas.length} fragments`);
    } catch (e) {
      check("live gateway round (minimax-m2.7-free)", false, (e as Error).message.slice(0, 140));
    }
  }
}

// ── 5. ROUTES (live dev server :3000) ─────────────────────────
if (want("routes")) {
  console.log("\n── 5. LIVE ROUTES (dev server :3000) ──");
  const BASE = "http://localhost:3000";

  const post = await fetch(`${BASE}/api/agent/prefs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainProvider: "explabs" }),
  }).then((r) => r.json()) as { ok?: boolean; prefs?: { mainProvider?: string }; chain?: string[] };
  check("prefs accepts mainProvider=explabs", post.prefs?.mainProvider === "explabs" && post.chain?.[0] === "explabs", (post.chain ?? []).slice(0, 3).join(" → "));

  const getPrefs = await fetch(`${BASE}/api/agent/prefs`).then((r) => r.json()) as {
    env?: { explabsBase?: string; explabsModels?: string[] };
  };
  check("prefs env exposes the gateway base + waterfall", (getPrefs.env?.explabsBase ?? "").includes("experientiallabs.ai") && getPrefs.env?.explabsModels?.[0] === "minimax-m2.7-free", `${getPrefs.env?.explabsBase} · ${getPrefs.env?.explabsModels?.[0]}`);

  const health = await fetch(`${BASE}/api/agent/health`).then((r) => r.json()) as {
    agent?: { providers?: Array<{ name: string; configured: boolean; detail?: string }> };
    llmBudget?: Record<string, unknown>;
  };
  const xpl = (health.agent?.providers ?? []).find((p) => p.name === "explabs");
  check("health lists explabs as a provider", Boolean(xpl), (health.agent?.providers ?? []).map((p) => p.name).join(","));
  check("health: explabs configured (xpl_ key present in .env)", xpl?.configured === true, (xpl?.detail ?? "").slice(0, 90));

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
delete process.env.EXPLABS_API_BASE;
delete process.env.EXPLABS_MODELS;

console.log("\n" + "═".repeat(64));
if (failures.length === 0) {
  console.log("ALL v4.3 CHECKS PASSED ✅");
} else {
  console.log(`FAILED: ${failures.length} ❌`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
