// ─────────────────────────────────────────────────────────────
// LLM provider layer for the autonomous agent.
//
// Primary:  Groq (openai/gpt-oss-120b) via the OpenAI-compatible
//           chat/completions API with NATIVE function calling —
//           uses GROQ_API_KEY from .env (v3.5, the user's key).
// Second:   OpenRouter GLM-5.2 (z-ai/glm-5.2) and NVIDIA NIM
//           Nemotron-3-Ultra — v4.1 MAIN-MODEL toggles.
// Then:     Z.ai GLM direct, Gemini, OpenAI, and the z-ai-web-dev-sdk
//           ReAct-JSON fallback (build-sandbox only) — the chain
//           never dead-ends.
//
// Selection: AGENT_LLM_PROVIDER = groq | openrouter | explabs |
//             freechain | nvidia | ollama | glm | gemini | openai |
//             zai | auto (default)
//
// v4.1 MODEL TOGGLE + RESILIENCE (Claude Code / OpenClaw style):
//   • MAIN MODEL TOGGLE — the console picks the main provider
//     (Groq ⚡ / GLM 5.2 🧠 / Nemotron 🔬 / …); everything else
//     becomes an ordered FALLBACK chain, exactly like Antigravity's
//     model selector: tools execute against whichever model is
//     selected, and a dead main model hands off with memory intact.
//   • REQUEST QUEUING & BACKOFF — every OAI-wire provider now goes
//     through withLlmResilience() (llm-resilience.ts): per-provider
//     serial queue, tenacity-style exponential backoff with full
//     jitter, Retry-After honored, circuit breaker. Retry/wait lines
//     stream to the xterm console live.
//   • REASONING STREAMS — NVIDIA NEMOTRON streams delta.reasoning_
//     content and OpenRouter GLM-5.2 streams delta.reasoning; both
//     are parsed on a SEPARATE channel (never mixed into content)
//     and surfaced live as “thinking…” events.
//   • SSE mid-stream errors — NVIDIA answers HTTP 200 and embeds
//     {"error":{"code":503}} inside the stream; that is detected
//     and retried instead of silently returning an empty answer.
//   • OpenRouter usage carries COST (USD) — the live meters show $.
//
// v4.3 EXPERIENTIAL LABS GATEWAY (MAIN-MODEL toggle):
//   • One xpl_ key (EXPLABS_API_KEY) → 313 models behind
//     https://api.experientiallabs.ai/v1 — an OpenAI-compatible
//     gateway that ALSO runs its own per-model provider waterfall
//     upstream (every slug fails over across providers before the
//     error ever reaches us). Point ANY OpenAI client at it.
//   • Verified live on the owner's key: streaming tool-call deltas
//     (OpenAI shape), usage in the final chunk incl.
//     completion_tokens_details.reasoning_tokens + exact USD cost,
//     Retry-After-honoring 429s, and minimax-m2.7-free — a genuinely
//     FREE model with native tool calling (cost: 0).
//   • EXPLABS_MODELS (default minimax-m2.7-free → kimi-k2.6 →
//     glm-5.2 → qwen3.6-flash) rotates on model-level walls
//     (geo / not-granted / free-tier-payment 429s) so one bad slug
//     never ends the round; 429/5xx backoff stays in the shared
//     resilience layer; sampling params are deliberately NOT sent
//     (the gateway's catalog spans hundreds of models, many pin
//     temperature/top_p — a minimal body is the documented safe
//     shape, with an invalid_parameter → minimal-body retry).
//
// v4.2 FREE CHAIN + BUDGET AUTO-TAKEOVER:
//   • FREE-CHAIN toggle — OpenRouter :free relay: poolside/
//     laguna-s-2.1:free → nvidia/nemotron-3.5-lightning:free →
//     dots-studio/dots3-note-preview:free. Zero-cost execution on
//     ANY OpenRouter key (works with zero credits — streaming +
//     usage.reasoning_tokens in the final chunk, @openrouter/sdk
//     shape). Each model rotates on 429/402/budget automatically.
//   • DAILY BUDGET SERVER (llm-budget.ts) — every provider gets a
//     400/day request budget (env AGENT_PROVIDER_DAILY_BUDGET);
//     when it is spent the chain AUTO-TAKES-OVER with the next
//     provider (memory preserved) — the task always completes.
//     Status: /api/agent/health llmBudget + MCP agent_budget tool.
//   • OLLAMA local provider — open-weights inference at
//     OLLAMA_BASE_URL (default 127.0.0.1:11434/v1, model
//     qwen2.5-coder) — guaranteed zero-cost uptime, offline, no
//     rate limits (Ollama / vLLM / LM Studio all speak the same
//     OpenAI-compatible wire).
//   • OpenRouter 402 (out of credits) now fails OVER to the free
//     chain instead of hard-ending the run.
//
// v3.5 GROQ + Z.AI GLM:
//   • Groq is the PRIMARY provider (user's key, openai/gpt-oss-120b) —
//     fast, generous free tier, far fewer 429s than Gemini.
//   • Z.ai GLM (glm-4.6) is the SECOND provider — a real GLM key from
//     https://z.ai over the same OpenAI-compatible protocol.
//   • auto chain: groq → glm → gemini → openai → zai(sandbox SDK).
//   • Groq 403 "Forbidden" from datacenter regions is a pre-auth edge
//     geo-block (a fake key gets the identical response) — classified
//     as provider-unavailable so the chain falls through, exactly like
//     the Gemini geo-block.
//
// v3.7 SPEED + HANDOFF:
//   • GROQ_REASONING_EFFORT (default "low") — gpt-oss models spend
//     MOST of their latency on hidden reasoning; "low" cuts a round
//     from ~90s to ~15-35s with near-identical code quality. Set
//     "medium"/"high" for harder problems. (The "552s for 6 tool
//     calls" complaint was exactly this.)
//   • generateWithAuto now reports a HANDOFF note whenever the active
//     provider dies mid-run and the next one takes over — the runner
//     surfaces it in the transcript so memory-continuation is visible.
//
// v3.4 MARATHON + THOUGHT-SIGNATURE fixes:
//   • Gemini 2.5 thinking models attach a thoughtSignature to every
//     function-call part and REFUSE the next request unless those
//     parts are replayed verbatim ("HTTP 400: Function call is missing
//     a thought_signature"). Model turns now carry rawParts (the exact
//     parts the API returned) and are replayed verbatim — this was the
//     bug that killed runs after ONE tool call (~1 minute).
//   • Long-run knobs (env): AGENT_MAX_ROUNDS, AGENT_BUDGET_MINUTES,
//     AGENT_LLM_MAX_TOKENS, AGENT_LLM_TIMEOUT_MS.
//   • Transient retries (429/5xx/network) with backoff on BOTH REST
//     providers + a 400-recovery path that compacts history to text,
//     so one hiccup can never end a run early.
// ─────────────────────────────────────────────────────────────

import type { ToolDef } from "./tools";
import { withLlmResilience, LlmCircuitOpenError, type RetryNotice } from "./llm-resilience";
import { budgetInfo, recordBudgetRequest, budgetLimitFor } from "./llm-budget";
import { publish } from "./event-bus";

/** v4.1 — every provider in the registry (main-model toggle values).
 *  v4.2 adds freechain (OpenRouter :free relay) and ollama (local);
 *  v4.3 adds explabs (Experiential Labs gateway).
 *  v4.4 turns the chain into an INFINITE RELAY: a provider transport
 *  error (400/5xx/stream/network) rotates to the next model/provider
 *  instead of killing the run, and after a FULL pass the engine wraps
 *  back around to the first provider with exponential backoff —
 *  "1 fails → 2 → 3 … → N → back to 1" — until the chain deadline. */
export type ProviderName =
  | "groq"
  | "openrouter"
  | "explabs"
  | "freechain"
  | "nvidia"
  | "ollama"
  | "glm"
  | "gemini"
  | "openai"
  | "zai"
  // v5.2 — the deterministic no-network fallback engine.
  | "offline";

/** One budget line in the live terminal feed (💰, loud). */
function announceBudget(text: string): void {
  publish("terminal", "line", { kind: "budget", text: `💰 ${text}` });
}

/** v4.4 — relay rotation lines (🔁, wrap-around rounds). */
function announceRelay(text: string): void {
  publish("terminal", "line", { kind: "note", text: `🔁 ${text}` });
}

/** v4.4 — positive-integer env read with an empty-string guard. */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Gemini 2.5 thinking models attach a thoughtSignature to each
   *  function-call part; the API requires it to be replayed verbatim
   *  on every later turn or the request fails with HTTP 400. */
  thoughtSignature?: string;
}

// Neutral conversation history — providers adapt it to their wire format
export type HistoryTurn =
  | { role: "user"; text: string }
  | { role: "model"; text?: string; toolCalls?: AgentToolCall[]; /** Verbatim provider parts (Gemini only) — preserves thoughtSignature fields the API demands on replay. */ rawParts?: unknown[] }
  | { role: "toolResults"; results: Array<{ name: string; result: unknown }> };

export interface LlmResponse {
  text?: string;
  toolCalls?: AgentToolCall[];
  tokens: number;
  /** v4.0 per-round usage detail — streamed live to the token meters. */
  usage?: LlmUsage;
  /** Raw tail of a tool-call JSON that was cut off mid-output (token limit). */
  truncatedToolCall?: string;
  /** v4.1 — the model id that actually served this round (badges,
   *  usage meter, run notes). */
  model?: string;
  /** v4.1 — chain-of-thought text the model streamed on a separate
   *  channel (NVIDIA reasoning_content / OpenRouter reasoning).
   *  Kept OUT of text and history replay — providers drop it — but
   *  surfaced live as “thinking…” in the console. */
  reasoningText?: string;
  /** The EXACT parts the Gemini API returned for this model turn —
   *  stored in history and replayed verbatim so thoughtSignature
   *  fields survive (see v3.4 note above). Other providers ignore it. */
  rawParts?: unknown[];
}

/** v4.0 usage detail captured per round (prompt/completion/cached tokens,
 * time-to-first-token, tokens/sec). Streaming providers fill it live. */
export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  ttftMs?: number;
  durationMs?: number;
  tokPerSec?: number;
  /** v4.1 — tokens the model spent on hidden reasoning (NIM/OpenRouter
   *  report it in completion_tokens_details.reasoning_tokens). */
  reasoningTokens?: number;
  /** v4.1 — USD cost of this round (OpenRouter reports exact cost). */
  costUsd?: number;
  /** Set when the provider sent no usage block and values are estimated. */
  estimated?: boolean;
}

/** v4.0 streaming options — passed through generateWithAuto to the
 * OAI-wire providers (Groq/GLM/OpenAI/OpenRouter/NVIDIA). Gemini and
 * z-ai ignore them. */
export interface GenerateOpts {
  /** Called with each token fragment while the model generates. */
  onDelta?: (fragment: string) => void;
  /** v4.1 — chain-of-thought fragments (reasoning_content/reasoning
   *  deltas), delivered on their own channel so the console can show
   *  live “thinking…” without polluting the answer text. */
  onReasoning?: (fragment: string) => void;
  /** Called when a transient-error retry restarts generation (the UI
   * clears the partial live text so it is not shown twice). */
  onReset?: () => void;
  /** v4.1 — fired before each backoff wait (queue/retry notices). */
  onRetry?: (notice: RetryNotice) => void;
}

export interface LlmProvider {
  name: ProviderName;
  generate(history: HistoryTurn[], tools: ToolDef[], system: string, opts?: GenerateOpts): Promise<LlmResponse>;
}

/** Gemini auth/geo/network unavailable → caller should fall back. */
export class ProviderUnavailableError extends Error {
  /** v4.1 — server-demanded wait (Retry-After header / 429 body).
   *  withLlmResilience honors it EXACTLY; values > 45s fail over. */
  retryAfterMs?: number;
  constructor(
    public provider: string,
    message: string
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/**
 * No usable LLM provider on this machine (no key in .env, no .z-ai-config).
 * Carries an ACTIONABLE message — the exact fix steps — so a fresh install
 * can never surface a cryptic SDK error like "init failed: Configuration
 * file not found…". This is the Claude Code convention: tell the user how
 * to add a key instead of failing mysteriously.
 */
export class NoLlmProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoLlmProviderError";
  }
}

/** v4.2 — the provider's DAILY REQUEST BUDGET is spent (llm-budget.ts).
 *  Extends ProviderUnavailableError so the auto chain treats it as a
 *  skip-and-failover (NEVER retried — waiting cannot help until the
 *  UTC-midnight reset) and the next provider takes over instantly.
 *  This is the "automatically takes after 400" auto-takeover. */
export class ProviderBudgetExhaustedError extends ProviderUnavailableError {
  constructor(
    provider: string,
    message: string,
    public budget: { used: number; limit: number; resetsInMs: number }
  ) {
    super(provider, message);
    this.name = "ProviderBudgetExhaustedError";
  }
}

// ── Result compaction (keep LLM context small in both providers) ──
const TOOL_RESULT_MAX = 3500;

export function compactToolResult(result: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(result);
  } catch {
    return { error: "result not serializable" };
  }
  if (json.length <= TOOL_RESULT_MAX) return result;
  // Re-serialize with the job list (largest field) trimmed
  if (result && typeof result === "object" && Array.isArray((result as { jobs?: unknown }).jobs)) {
    const clone = { ...(result as Record<string, unknown>) };
    clone.jobs = (clone.jobs as unknown[]).slice(0, 5);
    const trimmed = JSON.stringify(clone);
    if (trimmed.length <= TOOL_RESULT_MAX) return { ...clone, note: "job list trimmed to 5 — raise limit or search narrower" };
    return { ...clone, note: "trimmed" };
  }
  return { truncated: json.slice(0, TOOL_RESULT_MAX) };
}

// ═════════════════════════════════════════════════════════════
// Gemini provider — native function calling over REST
// ═════════════════════════════════════════════════════════════

// ── Env access (LAZY, per call) ─────────────────────────────────────────
// Read via bracket notation at CALL time, never at module load:
// 1. bracket access defeats Next.js build-time inlining of process.env.X;
// 2. values added to .env after the server booted are picked up without a
//    restart — the #1 "I added my key but the agent still says no key"
//    support ticket.
const env = (name: string): string => process.env[name] || "";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const geminiModel = () => env("GEMINI_MODEL") || "gemini-flash-latest";
const geminiKey = () => env("GEMINI_API_KEY");

// v3.4 long-run knobs (shared with the OpenAI provider):
//  - more output tokens → fewer truncated tool calls (thinking models
//    spend candidate tokens on reasoning, so 2048 starved the JSON)
//  - longer timeout → thinking models legitimately take >60s
const llmMaxTokens = (fallback: number) => {
  const v = Number(env("AGENT_LLM_MAX_TOKENS"));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
};
const llmTimeoutMs = () => {
  const v = Number(env("AGENT_LLM_TIMEOUT_MS"));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 180_000;
};

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
}
interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

/** Keep function-call parts (with their thoughtSignature), signature-bearing
 *  parts and normal text — drop only thought-summary text parts, which the
 *  API neither needs nor wants replayed. */
function replayableParts(parts: GeminiPart[]): GeminiPart[] {
  const kept = parts.filter(
    (p) => p.functionCall !== undefined || p.functionResponse !== undefined || p.thoughtSignature !== undefined || !(p.thought === true)
  );
  return kept.length > 0 ? kept : [{ text: "…" }];
}

export function historyToGemini(history: HistoryTurn[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const turn of history) {
    if (turn.role === "user") {
      contents.push({ role: "user", parts: [{ text: turn.text }] });
    } else if (turn.role === "model") {
      const raw = turn.rawParts as GeminiPart[] | undefined;
      if (Array.isArray(raw) && raw.length > 0) {
        // VERBATIM replay (minus thought summaries): this is the v3.4 fix.
        // Reconstructing parts from {name, args} silently drops the
        // thoughtSignature Gemini 2.5 attaches to function calls → the
        // next request fails with "missing a thought_signature".
        contents.push({ role: "model", parts: replayableParts(raw) });
      } else {
        const parts: GeminiPart[] = [];
        if (turn.text) parts.push({ text: turn.text });
        for (const c of turn.toolCalls ?? []) {
          parts.push({
            functionCall: { name: c.name, args: c.args },
            ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
          });
        }
        if (parts.length === 0) parts.push({ text: "…" });
        contents.push({ role: "model", parts });
      }
    } else {
      contents.push({
        role: "user",
        parts: turn.results.map((r) => ({
          functionResponse: { name: r.name, response: { result: r.result } },
        })),
      });
    }
  }
  return contents;
}

/** Gemini rejected the replayed history because a function-call part was
 *  missing its thoughtSignature. Recoverable: compact history to text and
 *  retry — no functionCall parts in history → no signature requirement. */
class ThoughtSignatureError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ThoughtSignatureError";
  }
}

async function geminiGenerate(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string
): Promise<LlmResponse> {
  if (!geminiKey()) throw new ProviderUnavailableError("gemini", "GEMINI_API_KEY not set");

  // v3.4: transient failures (429 / 5xx / network) no longer end a run —
  // retry with backoff. The thought-signature 400 gets one IMMEDIATE
  // text-compaction retry. Geo/auth errors stay non-retryable (fallback).
  const RETRY_DELAYS_MS = [8_000, 25_000];
  let effectiveHistory = history;
  let compacted = false;
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      console.warn(`[agent] gemini transient error — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1})`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await geminiGenerateOnce(effectiveHistory, tools, system);
    } catch (e) {
      lastError = e;
      if (e instanceof ThoughtSignatureError) {
        if (!compacted) {
          compacted = true;
          effectiveHistory = compactHistoryToText(history);
          console.warn("[agent] gemini thought-signature 400 — compacting history to text protocol and retrying immediately");
          attempt--; // immediate retry, does not consume the backoff budget
          continue;
        }
        // Compacted history has no function-call parts; a repeat 400 is a
        // different protocol problem → let the auto chain fall back.
        throw new ProviderUnavailableError("gemini", e.message);
      }
      const msg = (e as Error).message ?? "";
      const transient = e instanceof ProviderUnavailableError && /HTTP (429|5\d\d):|network:/i.test(msg);
      if (transient && attempt < RETRY_DELAYS_MS.length) continue;
      throw e;
    }
  }
  throw lastError;
}

async function geminiGenerateOnce(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string
): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: system }] },
    contents: historyToGemini(history),
    generationConfig: { temperature: 0.35, maxOutputTokens: llmMaxTokens(8192) },
  };
  if (tools.length > 0) {
    body.tools = [
      {
        function_declarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
    body.tool_config = { function_calling_config: { mode: "AUTO" } };
  }

  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${geminiModel()}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(llmTimeoutMs()),
    });
  } catch (e) {
    throw new ProviderUnavailableError("gemini", `network: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const msg = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
    // The v3.4 bug signature: replayed function-call parts missing the
    // thoughtSignature Gemini 2.5 thinking models demand.
    if (res.status === 400 && /thought[_\s-]?signature/i.test(errText)) {
      throw new ThoughtSignatureError(res.status, msg);
    }
    // Geo-block ("User location is not supported"), auth, quota, server errors → fallback
    if (res.status === 429 || res.status >= 500 || /location|API key|permission|quota/i.test(errText)) {
      throw new ProviderUnavailableError("gemini", msg);
    }
    throw new Error(`Gemini request error — ${msg}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }>;
    usageMetadata?: { totalTokenCount?: number };
  };

  const parts = data.candidates?.[0]?.content?.parts ?? [];
  let text: string | undefined;
  const toolCalls: AgentToolCall[] = [];
  for (const p of parts) {
    if (p.text && p.thought !== true) text = (text ?? "") + p.text;
    if (p.functionCall?.name) {
      toolCalls.push({
        name: p.functionCall.name,
        args: (p.functionCall.args ?? {}) as Record<string, unknown>,
        // Capture the signature so even the reconstructed-history path
        // (rawParts absent) can replay it correctly.
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
      });
    }
  }
  return {
    text: text?.trim() || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    tokens: data.usageMetadata?.totalTokenCount ?? 0,
    // The exact parts (signatures included) — stored by the runners and
    // replayed verbatim on every later turn.
    rawParts: parts.length > 0 ? parts : undefined,
  };
}

export const geminiProvider: LlmProvider = {
  name: "gemini",
  generate: geminiGenerate,
};

// ── Emergency history compaction (thought-signature 400 recovery) ──
// Converts the whole conversation into ONE plain-text user message: no
// functionCall parts in the request → no thoughtSignature requirement.
// The model is explicitly told every logged tool call ALREADY RAN and the
// results are real, so it continues the mission instead of restarting.
export function compactHistoryToText(history: HistoryTurn[]): HistoryTurn[] {
  const lines: string[] = [
    "[CONVERSATION HISTORY — compacted to plain text after a provider protocol error. Every tool call below ALREADY EXECUTED; the results are real. Continue the mission from here.]",
  ];
  for (const turn of history) {
    if (turn.role === "user") {
      lines.push("", "USER:", turn.text.slice(0, 2000));
    } else if (turn.role === "model") {
      if (turn.text) lines.push("", "ASSISTANT:", turn.text.slice(0, 1000));
      for (const c of turn.toolCalls ?? []) {
        lines.push(`ASSISTANT CALLED TOOL ${c.name} with ${JSON.stringify(c.args ?? {}).slice(0, 500)}`);
      }
    } else {
      for (const r of turn.results) {
        const json = (() => {
          try {
            return JSON.stringify(compactToolResult(r.result));
          } catch {
            return String(r.result);
          }
        })();
        lines.push(`TOOL RESULT ${r.name}: ${json.slice(0, 1200)}`);
      }
    }
  }
  lines.push("", "Continue toward the goal from here — you may call tools again; do not redo work whose results appear above.");
  return [{ role: "user", text: lines.join("\n") }];
}

// ═════════════════════════════════════════════════════════
// OpenAI provider — native function calling over REST
// (works with sk-proj-… project keys; optional)
// ═════════════════════════════════════════════════════════

const openaiBase = () => env("OPENAI_BASE_URL") || "https://api.openai.com/v1";
const openaiModel = () => env("OPENAI_MODEL") || "gpt-4o-mini";
const openaiKey = () => env("OPENAI_API_KEY");

interface OaiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OaiToolCall[];
  tool_call_id?: string;
}

// ═════════════════════════════════════════════════════════════
// v4.0 SHARED OAI-WIRE TRANSPORT — streaming + usage detail.
// One function serves the OpenAI, Groq and GLM providers: when the
// caller passes onDelta the request becomes an SSE stream and token
// fragments flow to the browser the instant the model produces them
// (the end of "the round finished 30s ago but the UI showed
// nothing"). Usage detail (prompt/completion/cached tokens, TTFT,
// tok/s) is captured on BOTH paths so the live meters work on every
// provider and the run history keeps exact numbers.
// ═════════════════════════════════════════════════════════════

interface OaiUsageJson {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** v4.1 — reasoning tokens (OpenRouter/NIM report these). */
  completion_tokens_details?: { reasoning_tokens?: number };
  /** v4.1 — OpenRouter reports the exact USD cost of the round. */
  cost?: number;
  /** Groq timing fields (seconds, float). */
  prompt_time?: number;
  completion_time?: number;
  total_time?: number;
}

function oaiUsageDetail(u: OaiUsageJson | undefined, durationMs: number, ttftMs?: number): LlmUsage {
  const completionTokens = u?.completion_tokens;
  const tokPerSec =
    completionTokens && completionTokens > 0 && durationMs > 0
      ? Math.round((completionTokens / (durationMs / 1000)) * 10) / 10
      : undefined;
  const cached = u?.prompt_tokens_details?.cached_tokens;
  const reasoning = u?.completion_tokens_details?.reasoning_tokens;
  return {
    ...(u?.prompt_tokens !== undefined ? { promptTokens: u.prompt_tokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(cached !== undefined && cached > 0 ? { cachedTokens: cached } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(u?.cost !== undefined && u.cost > 0 ? { costUsd: Math.round(u.cost * 1e6) / 1e6 } : {}),
    ...(ttftMs !== undefined ? { ttftMs } : {}),
    durationMs,
    ...(tokPerSec !== undefined ? { tokPerSec } : {}),
  };
}

function toAgentToolCalls(raw: OaiToolCall[]): AgentToolCall[] {
  return raw.map((c) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      /* malformed JSON args → empty, the tool self-corrects */
    }
    return { name: c.function.name, args };
  });
}

// ── v4.1 Retry-After helpers ─────────────────────────────────
/** "7.017" seconds (float) or an HTTP-date → ms (capped). */
function parseRetryAfterHeader(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const asSec = Number(trimmed);
  if (Number.isFinite(asSec) && asSec >= 0) return Math.round(Math.min(asSec * 1000, 120_000));
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}
/** Groq-style 429 body: "Please try again in 7.017s". */
function parseRetryFromBody(errText: string): number | undefined {
  const m = /try again in ([\d.]+)\s*s/i.exec(errText);
  if (m) return Math.round(Math.min(Number(m[1]) * 1000, 120_000));
  return undefined;
}

async function oaiChat(a: {
  provider: string;
  base: string;
  key: string;
  body: Record<string, unknown>;
  onDelta?: (fragment: string) => void;
  /** v4.1 — reasoning deltas on their own channel. */
  onReasoning?: (fragment: string) => void;
  /** OpenAI/OpenRouter/NIM need stream_options.include_usage for stream usage. */
  includeUsageStreamOption?: boolean;
  /** v4.1 — extra request headers (OpenRouter attribution). */
  headers?: Record<string, string>;
}): Promise<{
  text?: string;
  reasoningText?: string;
  toolCalls: OaiToolCall[];
  totalTokens: number;
  usage: LlmUsage;
  finishReason?: string | null;
  truncatedToolCall?: string;
}> {
  const startedAt = Date.now();
  const wantsStream = a.onDelta !== undefined;
  const body: Record<string, unknown> = {
    ...a.body,
    ...(wantsStream ? { stream: true } : {}),
    ...(wantsStream && a.includeUsageStreamOption ? { stream_options: { include_usage: true } } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${a.base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${a.key}`,
        ...(a.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(llmTimeoutMs()),
    });
  } catch (e) {
    throw new ProviderUnavailableError(a.provider, `network: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const msg = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
    // v4.1 — capture the server-demanded wait so withLlmResilience
    // honors it EXACTLY (429s from Groq/OpenRouter/NIM all send it).
    const err = new ProviderUnavailableError(a.provider, msg);
    const retryAfter = parseRetryAfterHeader(res.headers.get("retry-after"))
      ?? parseRetryFromBody(errText);
    if (retryAfter !== undefined) err.retryAfterMs = retryAfter;
    // 408/425 also retry; 400/404 are hard protocol errors.
    // v4.2: 402 (OpenRouter out of credits) FAILS OVER — the free
    // chain (same key, :free models) is exactly what should take over.
    if (
      res.status === 429 ||
      res.status === 408 ||
      res.status === 425 ||
      res.status === 401 ||
      res.status === 402 ||
      res.status === 403 ||
      res.status >= 500
    ) {
      throw err;
    }
    throw new Error(`${a.provider} request error — ${msg}`);
  }

  if (!wantsStream) {
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          /** v4.1 — OpenRouter GLM-5.2 returns reasoning on the message. */
          reasoning?: string | null;
          tool_calls?: OaiToolCall[];
        };
      }>;
      usage?: OaiUsageJson;
    };
    const message = data.choices?.[0]?.message;
    const reasoningText = typeof message?.reasoning === "string" && message.reasoning.length > 0 ? message.reasoning : undefined;
    if (reasoningText) a.onReasoning?.(reasoningText);
    return {
      text: message?.content?.trim() || undefined,
      reasoningText,
      toolCalls: message?.tool_calls ?? [],
      totalTokens: data.usage?.total_tokens ?? 0,
      usage: oaiUsageDetail(data.usage, Date.now() - startedAt),
    };
  }

  // STREAMING path — incremental SSE parse, fragments pushed as they land.
  if (!res.body) throw new ProviderUnavailableError(a.provider, "stream: empty response body");
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const assembled: Array<{ id: string; name: string; args: string }> = [];
  let totalTokens = 0;
  let rawUsage: OaiUsageJson | undefined;
  let finishReason: string | null | undefined;
  let ttftMs: number | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let chunk: {
          /** v4.1 — NVIDIA NIM answers HTTP 200 and then embeds the
           *  real error INSIDE the stream: data: {"error":{"code":503}}
           *  (verified live: "Service temporarily overloaded"). Treat it
           *  exactly like a 5xx response → transient, retried. */
          error?: { message?: string; code?: number };
          choices?: Array<{
            delta?: {
              content?: string | null;
              /** v4.1 — NVIDIA chain-of-thought deltas. */
              reasoning_content?: string | null;
              /** v4.1 — OpenRouter chain-of-thought deltas. */
              reasoning?: string | null;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: OaiUsageJson | null;
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) {
          const code = chunk.error.code ?? 0;
          const message = chunk.error.message ?? "stream error";
          // 401/403 inside a stream are auth problems → failover, no retry.
          if (code === 401 || code === 403) {
            throw new ProviderUnavailableError(a.provider, `stream-error: ${message}`);
          }
          throw new ProviderUnavailableError(a.provider, `stream-error: HTTP ${code || 503}: ${message.slice(0, 200)}`);
        }
        if (chunk.usage) {
          rawUsage = chunk.usage;
          totalTokens = chunk.usage.total_tokens ?? totalTokens;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (ttftMs === undefined) ttftMs = Date.now() - startedAt;
          contentParts.push(delta.content);
          a.onDelta?.(delta.content);
        }
        // v4.1 reasoning channel — NVIDIA reasoning_content, OpenRouter
        // reasoning. NEVER mixed into content (that would corrupt the
        // answer); forwarded live so the console shows "thinking…".
        const think = delta.reasoning_content ?? delta.reasoning;
        if (typeof think === "string" && think.length > 0) {
          reasoningParts.push(think);
          a.onReasoning?.(think);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          while (assembled.length <= i) assembled.push({ id: "", name: "", args: "" });
          const slot = assembled[i];
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
    }
  } catch (e) {
    if (e instanceof ProviderUnavailableError) throw e;
    throw new ProviderUnavailableError(a.provider, `stream: ${(e as Error).message}`);
  }

  const durationMs = Date.now() - startedAt;
  const text = contentParts.join("").trim() || undefined;
  const named = assembled.filter((c) => c.name);
  // v4.0 truncation guard (parity with the z-ai protocol): a tool call
  // cut off by the token limit (finish_reason=length, args JSON
  // malformed) is reported as truncatedToolCall so the runner can nudge
  // a re-issue instead of silently dropping the call.
  let truncatedToolCall: string | undefined;
  if (finishReason === "length" && named.length > 0) {
    const last = named[named.length - 1];
    try {
      JSON.parse(last.args || "{}");
    } catch {
      truncatedToolCall = `{"name":"${last.name}","arguments":${last.args.slice(0, 400)}`;
      named.pop();
    }
  }
  // Some compat endpoints never send usage on streams — estimate so
  // the live token meter still moves (chars/4 heuristic, flagged).
  let estimated = false;
  if (rawUsage === undefined) {
    estimated = true;
    const estPrompt = Math.ceil(JSON.stringify(a.body.messages ?? []).length / 4);
    const estCompletion = Math.ceil(contentParts.join("").length / 4);
    rawUsage = { prompt_tokens: estPrompt, completion_tokens: estCompletion, total_tokens: estPrompt + estCompletion };
  }
  if (totalTokens === 0 && rawUsage.total_tokens) totalTokens = rawUsage.total_tokens;
  const reasoningText = reasoningParts.join("").trim() || undefined;
  return {
    text,
    reasoningText,
    toolCalls: named.map((c) => ({
      id: c.id || "call_stream",
      type: "function" as const,
      function: { name: c.name, arguments: c.args },
    })),
    totalTokens,
    usage: { ...oaiUsageDetail(rawUsage, durationMs, ttftMs), ...(estimated ? { estimated: true } : {}) },
    finishReason,
    truncatedToolCall,
  };
}

function historyToOpenAi(history: HistoryTurn[], system: string): OaiMessage[] {
  const messages: OaiMessage[] = [{ role: "system", content: system }];
  // Pair tool results with the tool_call ids of the preceding model turn
  let lastIds: string[] = [];
  let idSeq = 0;
  for (const turn of history) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "model") {
      const calls = (turn.toolCalls ?? []).map((c) => {
        const id = `call_${idSeq++}`;
        return { id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } };
      });
      lastIds = calls.map((c) => c.id);
      messages.push({
        role: "assistant",
        content: turn.text ?? null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else {
      turn.results.forEach((r, i) => {
        const json = (() => {
          try {
            return JSON.stringify(r.result);
          } catch {
            return String(r.result);
          }
        })();
        messages.push({
          role: "tool",
          tool_call_id: lastIds[i] ?? `call_${idSeq++}`,
          content: (json ?? "{}").slice(0, TOOL_RESULT_MAX),
        });
      });
    }
  }
  return messages;
}

async function openaiGenerate(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts
): Promise<LlmResponse> {
  if (!openaiKey()) throw new ProviderUnavailableError("openai", "OPENAI_API_KEY not set");
  // v4.1 — queue + exponential-jitter backoff + breaker (replaces the
  // old fixed-delay loop); onReset clears partial live text on retry.
  return withLlmResilience("openai", () => openaiGenerateOnce(history, tools, system, opts), {
    onRetry: () => opts?.onReset?.(),
  });
}

async function openaiGenerateOnce(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts
): Promise<LlmResponse> {
  const body: Record<string, unknown> = {
    model: openaiModel(),
    messages: historyToOpenAi(history, system),
    temperature: 0.35,
    max_tokens: llmMaxTokens(4096),
  };
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const r = await oaiChat({
    provider: "openai",
    base: openaiBase(),
    key: openaiKey(),
    body,
    onDelta: opts?.onDelta,
    includeUsageStreamOption: true,
  });
  const toolCalls = toAgentToolCalls(r.toolCalls);
  return {
    text: r.text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    tokens: r.totalTokens,
    usage: r.usage,
    model: openaiModel(),
    ...(r.reasoningText ? { reasoningText: r.reasoningText } : {}),
    ...(r.truncatedToolCall ? { truncatedToolCall: r.truncatedToolCall } : {}),
  };
}

export const openaiProvider: LlmProvider = {
  name: "openai",
  generate: openaiGenerate,
};

// ═════════════════════════════════════════════════════════════
// v3.5 — Groq (PRIMARY) + Z.ai GLM (second): OpenAI-compatible
// chat/completions with native function calling. All the OAI-wire
// providers reuse the transport above (historyToOpenAi) through one
// factory.
//
//   Groq      (.env): GROQ_API_KEY, GROQ_MODEL=openai/gpt-oss-120b,
//                    GROQ_API_BASE (rare override). Free keys:
//                    https://console.groq.com/keys
//   OpenRouter(.env): OPENROUTER_API_KEY (sk-or-v1-…),
//                    OPENROUTER_MODEL=z-ai/glm-5.2 (default),
//                    OPENROUTER_API_BASE. One key → 430+ models
//                    (GLM-5.2, Claude, GPT, Nemotron, …) with exact
//                    USD cost reporting. Keys: https://openrouter.ai
//   NVIDIA NIM(.env): NVIDIA_API_KEY (nvapi-…),
//                    NVIDIA_MODEL=nvidia/nemotron-3-ultra-550b-a55b,
//                    NVIDIA_API_BASE (integrate.api.nvidia.com/v1).
//                    Streams reasoning_content; verified live.
//   GLM       (.env): GLM_API_KEY (aliases ZAI_API_KEY / Z_AI_API_KEY),
//                    GLM_MODEL=glm-4.6, GLM_API_BASE (z.ai coding plan:
//                    https://api.z.ai/api/coding/paas/v4). Keys:
//                    https://z.ai / https://open.bigmodel.cn
//
// NOTE 403: Groq edge-blocks some datacenter regions BEFORE auth
// (bare {"error":{"message":"Forbidden"}} — a fake key gets the
// same response). That is a region block, not a key problem: the
// user's laptop serves directly; this build sandbox falls through
// to the next provider, exactly like the Gemini geo-block.
// ═════════════════════════════════════════════════════════════

const groqKey = () => env("GROQ_API_KEY");
const groqBase = () => env("GROQ_API_BASE") || env("GROQ_BASE_URL") || "https://api.groq.com/openai/v1";
// v4.1 — the free-text model override applies to the MAIN provider
// only (prevents an override meant for Groq from leaking into the
// OpenRouter model id after a toggle).
const mainProviderIs = (p: ProviderName) => {
  const main = getRuntimeLlmPrefs().mainProvider;
  return !main || main === p;
};
const groqModel = () => (mainProviderIs("groq") ? getRuntimeLlmPrefs().model : "") || env("GROQ_MODEL") || "openai/gpt-oss-120b";

// ── v4.0/v4.1 RUNTIME PREFS — UI-adjustable WITHOUT a restart ──
// The console exposes the MAIN-MODEL TOGGLE (Antigravity-style), a
// speed selector (reasoning effort), a model override and a
// streaming kill-switch; POST /api/agent/prefs writes here. Values
// live for the process lifetime (the UI re-posts them from
// localStorage on load).
export interface RuntimeLlmPrefs {
  reasoningEffort?: "low" | "medium" | "high";
  model?: string;
  /** v4.1 — the MAIN provider (model toggle). Everything else in the
   *  registry becomes an ordered FALLBACK behind it (Claude Code /
   *  OpenClaw pattern). */
  mainProvider?: ProviderName;
  /** Streaming can be turned off to debug a flaky proxy (default ON). */
  streaming?: boolean;
}
const PREFS_KEY = "__agentLlmRuntimePrefs";
export function getRuntimeLlmPrefs(): RuntimeLlmPrefs {
  return (globalThis as Record<string, unknown>)[PREFS_KEY] as RuntimeLlmPrefs | undefined ?? {};
}
/** null values CLEAR a key (used by /api/agent/prefs to reset tests/knobs). */
export function setRuntimeLlmPrefs(
  patch: { [K in keyof RuntimeLlmPrefs]?: RuntimeLlmPrefs[K] | null }
): RuntimeLlmPrefs {
  const merged: RuntimeLlmPrefs = { ...getRuntimeLlmPrefs() };
  for (const key of ["reasoningEffort", "model", "streaming", "mainProvider"] as const) {
    const v = (patch as Record<string, unknown>)[key];
    if (v === null || v === undefined) {
      if (v === null) delete merged[key];
    } else {
      (merged as Record<string, unknown>)[key] = v;
    }
  }
  (globalThis as Record<string, unknown>)[PREFS_KEY] = merged;
  return merged;
}

// ── v4.1 PROVIDER REGISTRY — the Antigravity-style toggle ──
// Order = fallback priority. The selected MAIN provider moves to
// the front; a dead main hands off down the list with the FULL
// conversation memory preserved (failover memory, v3.7).
// v4.2: freechain (OpenRouter :free relay) slots right after the
// paid OpenRouter model — when the paid model 402s (out of credits)
// the FREE relay takes over with the SAME key; ollama (local) is a
// zero-cost unlimited candidate whenever the daemon is running.
// v4.8 (user directive): EXPLABS (Experiential Labs, gpt-oss-120b-batch)
// is the PRIMARY provider — it sits FIRST. GROQ was demoted to the
// LAST choice (its key changed too); every other gateway keeps its
// relative order between them.
const PROVIDER_DEFAULT_ORDER: ProviderName[] = [
  "explabs",
  "openrouter",
  "freechain",
  "nvidia",
  "ollama",
  "glm",
  "gemini",
  "openai",
  "zai",
  "groq",
];
export function providerChainOrder(): ProviderName[] {
  const main = getRuntimeLlmPrefs().mainProvider;
  if (!main || main === "zai") return PROVIDER_DEFAULT_ORDER;
  return [main, ...PROVIDER_DEFAULT_ORDER.filter((p) => p !== main)];
}

const glmKey = () => env("GLM_API_KEY") || env("ZAI_GLMAPI_KEY") || env("ZAI_API_KEY") || env("Z_AI_API_KEY");
const glmBase = () => env("GLM_API_BASE") || env("ZAI_API_BASE") || "https://api.z.ai/api/paas/v4";
const glmModel = () => env("GLM_MODEL") || env("ZAI_MODEL") || "glm-4.6";

// ── v4.1 OpenRouter (GLM-5.2 main model) ──────────────────────
const openrouterKey = () => env("OPENROUTER_API_KEY");
const openrouterBase = () => env("OPENROUTER_API_BASE") || "https://openrouter.ai/api/v1";
const openrouterModel = () =>
  (mainProviderIs("openrouter") ? getRuntimeLlmPrefs().model : "") || env("OPENROUTER_MODEL") || "z-ai/glm-5.2";

// ── v4.1 NVIDIA NIM (nemotron-3-ultra, thinking model) ────────
const nvidiaKey = () => env("NVIDIA_API_KEY") || env("NVIDIA_NIM_API_KEY") || env("NIM_API_KEY");
const nvidiaBase = () => env("NVIDIA_API_BASE") || "https://integrate.api.nvidia.com/v1";
const nvidiaModel = () => env("NVIDIA_MODEL") || "nvidia/nemotron-3-ultra-550b-a55b";
// NIM thinking toggle — the user's snippet runs enable_thinking:true.
// The speed selector maps: Turbo(low) → OFF (much faster), Balanced /
// Deep → ON. NVIDIA_ENABLE_THINKING=0|1 forces it.
const nvidiaThinking = (): boolean => {
  const forced = env("NVIDIA_ENABLE_THINKING");
  if (forced === "0") return false;
  if (forced === "1") return true;
  const rt = getRuntimeLlmPrefs().reasoningEffort;
  if (rt === "low") return false;
  return true; // default ON (user's reference integration)
};

interface OaiStyleConfig {
  name: ProviderName;
  key: () => string;
  base: () => string;
  model: () => string;
  defaultMaxTokens: number;
  /** Omit → the provider's default sampling (gpt-oss prefers its own). */
  temperature?: number;
  /** v4.1 — top_p sampling (NVIDIA reference uses 0.95 with temp 1). */
  topP?: number;
  /** Extra request-body fields (reasoning knobs, chat_template_kwargs). */
  extraBody?: () => Record<string, unknown>;
  /** v4.1 — extra request headers (OpenRouter attribution). */
  headers?: () => Record<string, string>;
  /** v4.1 — ask for usage on streams (stream_options.include_usage). */
  includeUsageStreamOption?: boolean;
  /** v4.2 — count this provider against the daily request budget
   *  (default true). Ollama is local + unlimited → false; the
   *  freechain relay counts PER MODEL instead of per provider. */
  trackBudget?: boolean;
}

// v3.7 — gpt-oss on Groq accepts reasoning_effort low|medium|high.
// Default LOW: rounds finish ~3× faster and code quality stays high
// (the reasoning budget was the hidden latency hog). v4.0: the UI's
// speed selector overrides the env at RUNTIME (no restart).
//   env GROQ_REASONING_EFFORT=low|medium|high
const groqReasoningEffort = () => {
  const rt = getRuntimeLlmPrefs().reasoningEffort;
  if (rt) return rt;
  const v = env("GROQ_REASONING_EFFORT").toLowerCase();
  return v === "medium" || v === "high" || v === "low" ? v : "low";
};

// v4.0 streaming gate — ON by default (real-time console), kill-switch
// via runtime pref or AGENT_LLM_STREAM=0 for flaky proxies.
const streamingEnabled = () =>
  getRuntimeLlmPrefs().streaming !== false && env("AGENT_LLM_STREAM") !== "0";

const GROQ_CFG: OaiStyleConfig = {
  name: "groq",
  key: groqKey,
  base: groqBase,
  model: groqModel,
  defaultMaxTokens: 8192,
  extraBody: () =>
    /gpt-oss/i.test(groqModel()) ? { reasoning_effort: groqReasoningEffort() } : {},
};
const GLM_CFG: OaiStyleConfig = { name: "glm", key: glmKey, base: glmBase, model: glmModel, defaultMaxTokens: 8192, temperature: 0.35 };

// v4.1 — OpenRouter GLM-5.2. The unified `reasoning.effort` param
// maps the console's speed selector onto GLM-5.2's thinking budget
// (Turbo → low effort). Attribution headers follow OpenRouter's
// convention; usage carries the exact USD cost of every round.
const OPENROUTER_CFG: OaiStyleConfig = {
  name: "openrouter",
  key: openrouterKey,
  base: openrouterBase,
  model: openrouterModel,
  defaultMaxTokens: 8192,
  extraBody: () => ({
    reasoning: { effort: groqReasoningEffort() },
  }),
  headers: () => ({
    "HTTP-Referer": env("OPENROUTER_SITE_URL") || "http://localhost:3000",
    "X-Title": "Job Command Center",
  }),
  includeUsageStreamOption: true,
};

// v4.1 — NVIDIA NIM nemotron-3-ultra. Exactly the reference params
// from the user's integration: temperature 1, top_p 0.95,
// max_tokens 16384, chat_template_kwargs.enable_thinking, streaming
// with reasoning_content deltas. enable_thinking follows the speed
// selector (Turbo OFF for speed, Balanced/Deep ON for max quality).
const NVIDIA_CFG: OaiStyleConfig = {
  name: "nvidia",
  key: nvidiaKey,
  base: nvidiaBase,
  model: nvidiaModel,
  defaultMaxTokens: 16_384,
  temperature: 1,
  topP: 0.95,
  extraBody: () => ({
    chat_template_kwargs: { enable_thinking: nvidiaThinking() },
  }),
  includeUsageStreamOption: true,
};

// ── v4.2 FREE-CHAIN — OpenRouter :free relay (zero-cost) ──────
// The user's chain: poolside/laguna-s-2.1:free → nvidia/
// nemotron-3.5-lightning:free → dots-studio/dots3-note-preview:free.
// :free models work on ANY OpenRouter key (even zero credits) and
// cost $0; each is rate-limited (≈50 req/day with < $10 credits),
// so freechainGenerate() rotates down the list on 429/402/budget.
// Transport = the same oaiChat SSE path the @openrouter/sdk uses:
// content deltas while generating + usage (with
// completion_tokens_details.reasoning_tokens) in the final chunk —
// already parsed and surfaced live by the v4.1 usage meters.
const OPENROUTER_FREE_MODELS_DEFAULT = [
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3.5-lightning:free",
  "dots-studio/dots3-note-preview:free",
];
export function openrouterFreeModels(): string[] {
  const fromEnv = env("OPENROUTER_FREE_MODELS");
  const base = (fromEnv && fromEnv.trim() ? fromEnv : OPENROUTER_FREE_MODELS_DEFAULT.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const override = mainProviderIs("freechain") ? getRuntimeLlmPrefs().model ?? "" : "";
  if (override && !base.includes(override)) return [override, ...base];
  return base.length > 0 ? base : OPENROUTER_FREE_MODELS_DEFAULT;
}
const FREECHAIN_CFG: OaiStyleConfig = {
  name: "freechain",
  key: openrouterKey,
  base: openrouterBase,
  model: () => openrouterFreeModels()[0] ?? "poolside/laguna-s-2.1:free",
  defaultMaxTokens: 8192,
  headers: () => ({
    "HTTP-Referer": env("OPENROUTER_SITE_URL") || "http://localhost:3000",
    "X-Title": "Job Command Center",
  }),
  includeUsageStreamOption: true,
  trackBudget: false, // counted PER MODEL inside freechainGenerate
};

// ── v4.3 EXPERIENTIAL LABS — one-key model gateway (313 models) ─
// https://api.experientiallabs.ai/v1 · Authorization: Bearer xpl_…
// (EXPLABS_API_KEY). Every slug resolves through the gateway's own
// provider waterfall upstream; we add a SECOND layer of rotation:
// EXPLABS_MODELS tries each slug in order when one hits a
// model-level wall (403 model_location_not_supported /
// model_not_granted, 429 free_tier_requires_payment — verified
// live: paid OpenAI/Anthropic slugs 403 from some regions, the
// promotional free models want a card on file). Transient 429s
// (unavailable_route, Retry-After: 5) stay inside withLlmResilience.
// Verified-working default chain on the owner's key:
//   minimax-m2.7-free (FREE, native tool calls, reasoning tokens,
//   cost: 0) → kimi-k2.6 ($0.029/M) → glm-5.2 → qwen3.6-flash.
const explabsKey = () => env("EXPLABS_API_KEY");
const explabsBase = () => env("EXPLABS_API_BASE") || "https://api.experientiallabs.ai/v1";
const EXPLABS_MODELS_DEFAULT = ["minimax-m2.7-free", "kimi-k2.6", "glm-5.2", "qwen3.6-flash"];
export function explabsModels(): string[] {
  const fromEnv = env("EXPLABS_MODELS");
  const base = (fromEnv && fromEnv.trim() ? fromEnv : EXPLABS_MODELS_DEFAULT.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const override = mainProviderIs("explabs") ? getRuntimeLlmPrefs().model ?? "" : "";
  if (override && !base.includes(override)) return [override, ...base];
  return base.length > 0 ? base : EXPLABS_MODELS_DEFAULT;
}
const EXPLABS_CFG: OaiStyleConfig = {
  name: "explabs",
  key: explabsKey,
  base: explabsBase,
  model: () => explabsModels()[0] ?? "minimax-m2.7-free",
  defaultMaxTokens: 16_384,
  // NOTE — deliberately NO temperature / top_p: the gateway's catalog
  // spans 313 models and many pin their sampling (a rejected field
  // answers 400 invalid_parameter naming the param). The documented
  // safe shape is a minimal body; the speed selector stays respected
  // by every other provider that accepts sampling params.
  includeUsageStreamOption: true, // usage (reasoning_tokens + cost) in the final chunk — verified live
  trackBudget: false, // counted PER MODEL inside explabsGenerate
};

// ── v4.2 OLLAMA — local open-weights inference (zero cost, unlimited) ──
// Ollama (and vLLM / LM Studio behind the same OpenAI-compatible
// wire) serve coding models like Qwen2.5-Coder / DeepSeek-Coder
// from the user's own CPU/GPU: no API key, no rate limits, offline.
//   OLLAMA_BASE_URL (default http://127.0.0.1:11434/v1)
//   OLLAMA_MODEL    (default qwen2.5-coder:7b)
const ollamaBase = () => env("OLLAMA_BASE_URL") || "http://127.0.0.1:11434/v1";
const ollamaModel = () => env("OLLAMA_MODEL") || "qwen2.5-coder:7b";
const OLLAMA_PROBE_KEY = "__agentOllamaProbe";
const OLLAMA_PROBE_TTL_MS = 60_000;
/** Is the local Ollama daemon answering? (cached 60s; never throws) */
export async function ollamaAvailable(): Promise<boolean> {
  const gg = globalThis as Record<string, unknown>;
  const cached = gg[OLLAMA_PROBE_KEY] as { ok: boolean; at: number } | undefined;
  if (cached && Date.now() - cached.at < OLLAMA_PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    const res = await fetch(`${ollamaBase()}/models`, { signal: AbortSignal.timeout(1500) });
    ok = res.ok;
  } catch {
    ok = false;
  }
  gg[OLLAMA_PROBE_KEY] = { ok, at: Date.now() };
  return ok;
}
const OLLAMA_CFG: OaiStyleConfig = {
  name: "ollama",
  key: () => env("OLLAMA_API_KEY") || "ollama-local",
  base: ollamaBase,
  model: ollamaModel,
  defaultMaxTokens: 8192,
  temperature: 0.2,
  trackBudget: false, // local → unlimited by design
};

async function oaiStyleGenerate(
  cfg: OaiStyleConfig,
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts
): Promise<LlmResponse> {
  if (!cfg.key()) throw new ProviderUnavailableError(cfg.name, `${cfg.name} key not set`);

  // v4.2 BUDGET-AWARE AUTO-TAKEOVER — when this provider's daily
  // request budget is spent it is skipped INSTANTLY (no wasted
  // round-trip) and the chain moves on; counters reset at UTC
  // midnight, the same moment the real providers reset their own
  // daily windows. This is the "server that automatically takes
  // over after 400" — surfaced in the terminal feed as a 💰 line.
  if (cfg.trackBudget !== false) {
    const budget = await budgetInfo(cfg.name);
    if (budget.exhausted) {
      throw new ProviderBudgetExhaustedError(
        cfg.name,
        `${cfg.name}: daily budget exhausted (${budget.used}/${budget.limit} requests today) — auto-fallback engaged, resets at UTC midnight in ${Math.round(budget.resetsInMs / 3_600_000)}h`,
        { used: budget.used, limit: budget.limit, resetsInMs: budget.resetsInMs }
      );
    }
  }

  // v4.1 REQUEST QUEUING & BACKOFF — every OAI-wire provider runs
  // through the resilience layer (serial queue + tenacity-style
  // exponential-jitter backoff honoring Retry-After + circuit
  // breaker). onReset clears partial live text when a retry starts;
  // onRetry is forwarded so the runner can show a live retry note.
  // Each ATTEMPT counts against the budget (429'd requests consume
  // the real providers' rate-limit windows too).
  return withLlmResilience(
    cfg.name,
    async () => {
      if (cfg.trackBudget !== false) recordBudgetRequest(cfg.name);
      return oaiStyleGenerateOnce(cfg, history, tools, system, opts);
    },
    {
      onRetry: () => opts?.onReset?.(),
    }
  );
}

async function oaiStyleGenerateOnce(
  cfg: OaiStyleConfig,
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts,
  /** v4.2 — per-MODEL override (the freechain relay pins the exact
   *  :free model it is currently trying; undefined → cfg.model()). */
  modelOverride?: string,
  /** v4.3 — strip size/sampling knobs (model + messages + tools
   *  ONLY). Used by the explabs invalid_parameter recovery: models
   *  that pin their sampling or cap output tokens get ONE minimal-
   *  body retry before the rotation moves on. */
  minimalBody?: boolean
): Promise<LlmResponse> {
  const model = modelOverride ?? cfg.model();
  const body: Record<string, unknown> = {
    model,
    messages: historyToOpenAi(history, system),
    ...(minimalBody ? {} : { max_tokens: llmMaxTokens(cfg.defaultMaxTokens) }),
    ...(cfg.extraBody ? cfg.extraBody() : {}),
  };
  if (!minimalBody && cfg.temperature !== undefined) body.temperature = cfg.temperature;
  if (!minimalBody && cfg.topP !== undefined) body.top_p = cfg.topP;
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const r = await oaiChat({
    provider: cfg.name,
    base: cfg.base(),
    key: cfg.key(),
    body,
    // v4.0: token fragments stream to the UI while the model works.
    onDelta: streamingEnabled() ? opts?.onDelta : undefined,
    // v4.1: chain-of-thought deltas on their own live channel.
    onReasoning: streamingEnabled() ? opts?.onReasoning : undefined,
    ...(cfg.headers ? { headers: cfg.headers() } : {}),
    ...(cfg.includeUsageStreamOption ? { includeUsageStreamOption: true } : {}),
  });
  const toolCalls = toAgentToolCalls(r.toolCalls);
  return {
    text: r.text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    tokens: r.totalTokens,
    usage: r.usage,
    model,
    ...(r.reasoningText ? { reasoningText: r.reasoningText } : {}),
    ...(r.truncatedToolCall ? { truncatedToolCall: r.truncatedToolCall } : {}),
  };
}

export const groqProvider: LlmProvider = {
  name: "groq",
  generate: (history, tools, system, opts) => oaiStyleGenerate(GROQ_CFG, history, tools, system, opts),
};

export const glmProvider: LlmProvider = {
  name: "glm",
  generate: (history, tools, system, opts) => oaiStyleGenerate(GLM_CFG, history, tools, system, opts),
};

// v4.1 — OpenRouter (GLM-5.2) and NVIDIA NIM (Nemotron) providers.
export const openrouterProvider: LlmProvider = {
  name: "openrouter",
  generate: (history, tools, system, opts) => oaiStyleGenerate(OPENROUTER_CFG, history, tools, system, opts),
};

export const nvidiaProvider: LlmProvider = {
  name: "nvidia",
  generate: (history, tools, system, opts) => oaiStyleGenerate(NVIDIA_CFG, history, tools, system, opts),
};

// ── v4.2 FREE-CHAIN generate — the zero-cost relay loop ──────
// Tries each :free model IN ORDER (poolside → nemotron-lightning →
// dots3): per-model daily budget → resilience-wrapped request →
// on 429/402/5xx/budget the NEXT free model takes over; only when
// every free model fails does the outer provider chain continue.
async function freechainGenerate(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts
): Promise<LlmResponse> {
  if (!openrouterKey()) throw new ProviderUnavailableError("freechain", "freechain needs OPENROUTER_API_KEY in .env");
  const models = openrouterFreeModels();
  const failures: string[] = [];
  for (const model of models) {
    const budgetKey = `freechain:${model}`;
    const budget = await budgetInfo(budgetKey);
    if (budget.exhausted) {
      const line = `${model}: free budget exhausted (${budget.used}/${budget.limit} today, resets in ${Math.round(budget.resetsInMs / 3_600_000)}h) — rotating to the next free model`;
      failures.push(line);
      announceBudget(line);
      continue;
    }
    try {
      return await withLlmResilience(
        budgetKey,
        async () => {
          recordBudgetRequest(budgetKey);
          return oaiStyleGenerateOnce(FREECHAIN_CFG, history, tools, system, opts, model);
        },
        { onRetry: () => opts?.onReset?.() }
      );
    } catch (e) {
      if (e instanceof ProviderBudgetExhaustedError) {
        failures.push(`${model}: ${(e as Error).message.slice(0, 140)}`);
        continue;
      }
      if (e instanceof ProviderUnavailableError) {
        // 429 / 402 / 5xx / stream-error → the next free model
        failures.push(`${model}: ${(e as Error).message.slice(0, 140)}`);
        continue;
      }
      if (e instanceof LlmCircuitOpenError) {
        failures.push(`${model}: circuit open (${(e as Error).message.slice(0, 100)})`);
        continue;
      }
      // v4.4 — transport-level refusals from the relay (HTTP 4xx/5xx,
      // stream errors, fetch failures) are MODEL-level walls, not
      // chain-level ones: rotate to the next free model. The run
      // never dies here.
      if (/request error|HTTP \d{3}|stream|network|timeout|aborted|fetch failed/i.test((e as Error).message ?? "")) {
        failures.push(`${model}: ${(e as Error).message.slice(0, 140)}`);
        continue;
      }
      throw e; // hard protocol error — surface it
    }
  }
  throw new ProviderUnavailableError(
    "freechain",
    `every free model failed — ${failures.join(" | ").slice(0, 300)}`
  );
}

export const freechainProvider: LlmProvider = {
  name: "freechain",
  generate: (history, tools, system, opts) => freechainGenerate(history, tools, system, opts),
};

// ── v4.3 EXPERIENTIAL LABS generate — waterfall-in-waterfall ──
// Two layers of failover: (1) the gateway itself re-routes each slug
// across ITS upstream providers; (2) this loop rotates through
// EXPLABS_MODELS when a slug still fails at the model level (geo /
// permission / free-tier-payment walls, exhausted per-model budget).
// Transient 429/5xx with Retry-After stay inside withLlmResilience.
// A hard 400 naming a sampling/size parameter (invalid_parameter /
// unsupported_parameter / max_tokens) gets ONE minimal-body retry on
// the SAME model before rotating — the gateway docs' exact guidance.
// v4.8 — batch-only explabs slugs learned at runtime (404 code
// "model_requires_batch"): live runs try each ONCE, then skip.
const EXPLABS_BATCH_ONLY = new Set<string>();

async function explabsGenerate(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts
): Promise<LlmResponse> {
  if (!explabsKey()) throw new ProviderUnavailableError("explabs", "EXPLABS_API_KEY not set in .env");
  const models = explabsModels();
  const failures: string[] = [];
  for (const model of models) {
    // v4.8 — batch-only slugs (e.g. gpt-oss-120b-batch answers 404
    // "model_requires_batch": submit via /v1/batches instead) are
    // tried ONCE per process, then skipped instantly for live runs.
    if (EXPLABS_BATCH_ONLY.has(model)) {
      failures.push(`${model}: batch-only slug (404 model_requires_batch) — live runs skip it`);
      continue;
    }
    const budgetKey = `explabs:${model}`;
    const budget = await budgetInfo(budgetKey);
    if (budget.exhausted) {
      const line = `explabs ${model}: daily budget exhausted (${budget.used}/${budget.limit} today, resets in ${Math.round(budget.resetsInMs / 3_600_000)}h) — rotating to the next gateway model`;
      failures.push(line);
      announceBudget(line);
      continue;
    }
    try {
      return await withLlmResilience(
        budgetKey,
        async () => {
          recordBudgetRequest(budgetKey);
          return oaiStyleGenerateOnce(EXPLABS_CFG, history, tools, system, opts, model);
        },
        { onRetry: () => opts?.onReset?.() }
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Model pinned its sampling or capped output tokens → ONE
      // minimal-body retry (model + messages + tools only) on the
      // same slug — the gateway's documented recovery for 400s
      // naming a parameter. Never a plain rethrow: the rotation
      // continues if it still refuses.
      if (
        !(e instanceof ProviderUnavailableError) &&
        !(e instanceof LlmCircuitOpenError) &&
        /invalid_parameter|unsupported_parameter|max_tokens|provider_output_too_large/i.test(msg)
      ) {
        try {
          return await withLlmResilience(
            budgetKey,
            async () => {
              recordBudgetRequest(budgetKey);
              return oaiStyleGenerateOnce(EXPLABS_CFG, history, tools, system, opts, model, true);
            },
            { onRetry: () => opts?.onReset?.() }
          );
        } catch (e2) {
          failures.push(`${model}: ${(e2 as Error).message?.slice(0, 140) ?? "minimal-body retry failed"}`);
          continue;
        }
      }
      if (e instanceof ProviderBudgetExhaustedError) {
        failures.push(`${model}: ${msg.slice(0, 140)}`);
        continue;
      }
      if (e instanceof ProviderUnavailableError) {
        // 403 model_location_not_supported / model_not_granted, 429
        // free_tier_requires_payment, 5xx all_routes_failed… → the
        // NEXT gateway model takes over on the same key.
        failures.push(`${model}: ${msg.slice(0, 140)}`);
        continue;
      }
      if (e instanceof LlmCircuitOpenError) {
        failures.push(`${model}: circuit open (${msg.slice(0, 100)})`);
        continue;
      }
      // v4.4 — the gateway's own transport errors (e.g. its upstream
      // answered HTTP 400 "provider rejected the request") are
      // MODEL-level walls on THIS slug: rotate to the next gateway
      // model with the same key. Killing a 10-provider chain because
      // one upstream 400'd is exactly the dead-end v4.4 removes.
      if (/request error|HTTP \d{3}|stream|network|timeout|aborted|fetch failed/i.test(msg)) {
        // batch-only slug (404 model_requires_batch) — remember it so
        // later calls in this process skip the wasted round-trip
        if (/model_requires_batch/i.test(msg)) EXPLABS_BATCH_ONLY.add(model);
        failures.push(`${model}: ${msg.slice(0, 140)}`);
        continue;
      }
      throw e; // hard protocol error — surface it
    }
  }
  throw new ProviderUnavailableError(
    "explabs",
    `every Experiential Labs model failed — ${failures.join(" | ").slice(0, 300)}`
  );
}

export const explabsProvider: LlmProvider = {
  name: "explabs",
  generate: (history, tools, system, opts) => explabsGenerate(history, tools, system, opts),
};

export const ollamaProvider: LlmProvider = {
  name: "ollama",
  generate: (history, tools, system, opts) => oaiStyleGenerate(OLLAMA_CFG, history, tools, system, opts),
};

// ═════════════════════════════════════════════════════════════
// z-ai provider — ReAct-style JSON tool protocol
// ═════════════════════════════════════════════════════════════

function toolsPrompt(tools: ToolDef[]): string {
  const lines = tools.map((t) => {
    const params = Object.entries(t.parameters.properties)
      .map(([k, v]) => {
        const req = t.parameters.required?.includes(k) ? "required" : "optional";
        const en = v.enum ? ` one of [${v.enum.join("|")}]` : "";
        return `"${k}" (${v.type}, ${req}${en}): ${v.description}`;
      })
      .join("; ");
    return `- ${t.name}(${params}) — ${t.description}`;
  });
  return lines.join("\n");
}

function historyToZaiMessages(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  const toolSystem =
    tools.length > 0
      ? `${system}

You have tools. Available tools:
${toolsPrompt(tools)}

TOOL PROTOCOL (strict):
- To call a tool, reply with ONLY this JSON (no markdown fences, no extra text):
  {"tool": "<tool_name>", "args": {<parameters>}}
- After each tool call you will receive: TOOL RESULT <name>: <json>
- You may call tools multiple times in sequence to fully accomplish the goal.
- When the goal is fully accomplished, reply with ONLY this JSON:
  {"final": "<your answer as concise markdown, under 350 words>"}
- Never invent tool names or parameters. Never fabricate job URLs — only report URLs that appeared in TOOL RESULTs.`
      : `${system}

The goal is wrapping up. Reply with ONLY this JSON (no fences):
{"final": "<your final answer as concise markdown, under 350 words>"}`;
  messages.push({ role: "system", content: toolSystem });

  for (const turn of history) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "model") {
      let content = turn.text ?? "";
      if (turn.toolCalls?.length) {
        content = JSON.stringify({ tool: turn.toolCalls[0].name, args: turn.toolCalls[0].args });
      }
      messages.push({ role: "assistant", content: content || "…" });
    } else {
      const parts = turn.results.map((r) => {
        const json = JSON.stringify(compactToolResult(r.result));
        return `TOOL RESULT ${r.name}: ${json.slice(0, TOOL_RESULT_MAX)}`;
      });
      messages.push({ role: "user", content: parts.join("\n") });
    }
  }
  return messages;
}

// ── Robust protocol parsing ──────────────────────────────────
// The z-ai model speaks the ReAct-JSON protocol but sometimes
// drifts: batches several tool calls as CONCATENATED objects,
// wraps them in an array, or embeds raw newlines inside JSON
// strings. This parser handles all of those shapes.

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/** Escape raw control characters that legally appear inside JSON strings. */
function repairControlChars(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

function parseMaybeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    /* try repaired */
  }
  try {
    return JSON.parse(repairControlChars(v));
  } catch {
    return null;
  }
}

/** Balanced-brace slice of the complete JSON value starting at startIdx. */
function balancedSlice(s: string, startIdx: number): { value: string; next: number } | null {
  const open = s[startIdx];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { value: s.slice(startIdx, i + 1), next: i + 1 };
    }
  }
  return null; // truncated tail
}

/** Repair a JSON value whose tail is missing closing braces/brackets —
 *  the #1 real-world z-ai protocol failure: the model emits a COMPLETE
 *  tool call but drops the final root `}` on deeply-escaped nested JSON
 *  (e.g. fs_write with a whole file inside "content"). finish_reason is
 *  "stop" — it is NOT truncation — so nudging it to re-issue just loops.
 *  String-aware: braces inside strings are never counted; an unclosed
 *  string (real truncation) is NOT repairable and returns null.
 *  Returns the repaired string, or null when repair is unsafe. */
function repairMissingClosers(s: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (open === undefined) return null; // extra closer — different defect
      if ((open === "{" && ch !== "}") || (open === "[" && ch !== "]")) return null; // mismatch
    }
  }
  if (inStr) return null; // string never closed → likely a REAL truncation
  if (stack.length === 0) return s; // already balanced
  let out = s;
  while (stack.length > 0) out += stack.pop() === "{" ? "}" : "]";
  return out;
}

/** Parse one JSON value, tolerating the two systematic model defects:
 *  raw control characters inside strings, and missing trailing closers. */
function parseLenient(v: string): unknown {
  const direct = parseMaybeJson(v);
  if (direct !== null) return direct;
  const repaired = repairMissingClosers(v);
  if (repaired !== null && repaired !== v) return parseMaybeJson(repaired);
  return null;
}

// Exported for the regression suite (scripts/test-gemini-history.ts).
export { repairMissingClosers, parseProtocol };

function toolCallFrom(entry: Record<string, unknown>): AgentToolCall | null {
  if (typeof entry.tool === "string") {
    return {
      name: entry.tool,
      args: entry.args && typeof entry.args === "object" ? (entry.args as Record<string, unknown>) : {},
    };
  }
  const fn = entry.function as { name?: string; arguments?: string } | undefined;
  if (fn && typeof fn.name === "string") {
    try {
      return { name: fn.name, args: JSON.parse(fn.arguments || "{}") as Record<string, unknown> };
    } catch {
      return { name: fn.name, args: {} };
    }
  }
  return null;
}

/**
 * Scan the whole message for every complete JSON value and collect
 * tool calls / final answers from them. Handles single objects,
 * arrays of calls, {"tool_calls":[…]} wrappers, and concatenated
 * objects without separators. Also detects a TRUNCATED trailing
 * tool call (output token limit) so the runner can ask for a re-issue.
 */
function parseProtocol(content: string): {
  toolCalls?: AgentToolCall[];
  final?: string;
  truncatedToolCall?: string;
} {
  const cleaned = stripFences(content);
  const calls: AgentToolCall[] = [];
  let final: string | undefined;
  let truncated: string | undefined;
  let idx = 0;
  while (idx < cleaned.length) {
    const nb = cleaned.indexOf("{", idx);
    const na = cleaned.indexOf("[", idx);
    let start: number;
    if (nb === -1 && na === -1) break;
    else if (nb === -1) start = na;
    else if (na === -1) start = nb;
    else start = Math.min(nb, na);
    let slice = balancedSlice(cleaned, start);
    if (!slice) {
      // Unbalanced tail. Before declaring it a truncation, try the
      // missing-closer repair — the model frequently DROPS the final
      // root brace on complete tool calls (finish=stop, not truncation).
      const tail = cleaned.slice(start);
      const repaired = repairMissingClosers(tail);
      const repairedVal = repaired !== null ? parseMaybeJson(repaired) : null;
      if (repairedVal !== null && typeof repairedVal === "object") {
        const entries: unknown[] = Array.isArray(repairedVal) ? repairedVal : [repairedVal];
        for (const e of entries) {
          if (!e || typeof e !== "object" || Array.isArray(e)) continue;
          const c = toolCallFrom(e as Record<string, unknown>);
          if (c) {
            calls.push(c);
            continue;
          }
          if (typeof (e as Record<string, unknown>).final === "string") {
            final = (e as Record<string, unknown>).final as string;
          }
        }
        break;
      }
      if (/^\{\s*"(tool|tool_calls)"/.test(tail.trim())) truncated = tail.slice(0, 400);
      break;
    }
    const val = parseLenient(slice.value);
    if (val !== null && typeof val === "object") {
      const entries: unknown[] = Array.isArray(val) ? val : [val];
      for (const e of entries) {
        if (!e || typeof e !== "object" || Array.isArray(e)) continue;
        const obj = e as Record<string, unknown>;
        const c = toolCallFrom(obj);
        if (c) {
          calls.push(c);
          continue;
        }
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls as unknown[]) {
            if (tc && typeof tc === "object" && !Array.isArray(tc)) {
              const c2 = toolCallFrom(tc as Record<string, unknown>);
              if (c2) calls.push(c2);
            }
          }
          continue;
        }
        if (typeof obj.final === "string") final = obj.final;
      }
    }
    idx = slice.next;
  }
  if (calls.length > 0) return { toolCalls: calls, truncatedToolCall: truncated };
  if (final !== undefined) return { final };
  if (truncated !== undefined) return { truncatedToolCall: truncated };
  return {};
}

// ── Debug dump (AGENT_DEBUG_LLM=1) — troubleshooting live protocol
// issues without guessing; writes raw provider outputs to a log file.
async function debugDumpLLM(tag: string, content: string): Promise<void> {
  if (env("AGENT_DEBUG_LLM") !== "1") return;
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync("llm-debug.log", `\n════ ${tag} · ${new Date().toISOString()} · ${content.length} chars ════\n${content}\n`);
  } catch {
    /* best-effort */
  }
}

async function zaiGenerate(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string
): Promise<LlmResponse> {
  const { default: ZAI } = await import("z-ai-web-dev-sdk");
  let zai: Awaited<ReturnType<typeof ZAI.create>>;
  try {
    zai = await ZAI.create();
  } catch (e) {
    throw new ProviderUnavailableError("zai", translateZaiInitError(e));
  }

  const completion = await zai.chat.completions.create({
    messages: historyToZaiMessages(history, tools, system),
    thinking: { type: "disabled" },
    // v3.4: without this the backend's small default output cap silently
    // truncated big fs_write JSON mid-tool-call — the "3 truncation
    // nudges then (no final answer produced)" death spiral.
    max_tokens: llmMaxTokens(8192),
  });
  const content: string = completion.choices[0]?.message?.content ?? "";
  const tokens = completion.usage?.total_tokens ?? 0;
  await debugDumpLLM(`zai raw (finish=${completion.choices[0]?.finish_reason ?? "n/a"})`, content);

  const proto = parseProtocol(content);
  if (proto.toolCalls && proto.toolCalls.length > 0) {
    return { toolCalls: proto.toolCalls, tokens, truncatedToolCall: proto.truncatedToolCall };
  }
  if (proto.final !== undefined) {
    return { text: proto.final, tokens };
  }
  if (proto.truncatedToolCall) {
    // A tool call was cut off by the output token limit — surface it so
    // the runner can nudge the model to re-issue in smaller chunks.
    return { tokens, truncatedToolCall: proto.truncatedToolCall };
  }
  // Models sometimes emit {"final": <unquoted markdown>} — invalid JSON but
  // a recognizable wrapper; strip it instead of treating it as the answer.
  const unwrap = content.match(/^\s*\{\s*"final"\s*:\s*"?([\s\S]*?)"?\s*\}\s*$/);
  if (unwrap) return { text: unwrap[1].trim(), tokens };
  // No recognizable protocol JSON → treat entire message as the final answer
  return { text: content.trim(), tokens };
}

export const zaiProvider: LlmProvider = {
  name: "zai",
  generate: zaiGenerateWithRetry,
};

/** z-ai with patient exponential backoff on rate limits (429). */
async function zaiGenerateWithRetry(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string
): Promise<LlmResponse> {
  let lastError: unknown;
  const MAX_ATTEMPTS = 4;
  const DELAYS_MS = [10_000, 30_000, 60_000, 120_000];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await zaiGenerate(history, tools, system);
    } catch (e) {
      lastError = e;
      const msg = (e as Error).message ?? "";
      if (/429|too many|rate limit/i.test(msg) && attempt < MAX_ATTEMPTS - 1) {
        const delayMs = DELAYS_MS[attempt] ?? 90_000;
        console.warn(`[agent] LLM rate-limited — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ═════════════════════════════════════════════════════════════
// Auto provider — registry chain with memoized start (10 min)
// v4.1: the chain order comes from providerChainOrder() — the MAIN
// model toggle puts the selected provider first, the rest become
// ordered fallbacks (Claude Code / OpenClaw architecture).
// ═════════════════════════════════════════════════════════════

interface AutoState {
  active: ProviderName;
  reason: string;
  decidedAt: number;
}
const AUTO_KEY = "__agentLlmAutoState";
const MEMO_TTL_MS = 10 * 60 * 1000;

function getAutoState(): AutoState | null {
  const g = globalThis as Record<string, unknown>;
  const state = g[AUTO_KEY] as AutoState | undefined;
  if (state && Date.now() - state.decidedAt < MEMO_TTL_MS) return state;
  return null;
}

function setAutoState(active: AutoState["active"], reason: string) {
  (globalThis as Record<string, unknown>)[AUTO_KEY] = {
    active,
    reason,
    decidedAt: Date.now(),
  } satisfies AutoState;
}

export function getActiveProviderInfo(): { provider: string; reason: string } {
  const state = getAutoState();
  const mode = process.env.AGENT_LLM_PROVIDER || "auto";
  if (mode === "groq") return { provider: "groq", reason: "forced via env" };
  if (mode === "openrouter") return { provider: "openrouter", reason: "forced via env" };
  if (mode === "freechain") return { provider: "freechain", reason: "forced via env — free-model relay" };
  if (mode === "ollama") return { provider: "ollama", reason: "forced via env — local inference" };
  if (mode === "nvidia") return { provider: "nvidia", reason: "forced via env" };
  if (mode === "glm") return { provider: "glm", reason: "forced via env" };
  if (mode === "gemini") return { provider: "gemini", reason: "forced via env" };
  if (mode === "openai") return { provider: "openai", reason: "forced via env" };
  if (mode === "zai") return { provider: "zai", reason: "forced via env" };
  const main = getRuntimeLlmPrefs().mainProvider;
  if (main) {
    return {
      provider: state?.active ?? main,
      reason:
        state?.reason ??
        `main model: ${main} (toggle) → fallbacks: ${providerChainOrder()
          .filter((p) => p !== main)
          .join(" → ")}`,
    };
  }
  return {
    provider: state?.active ?? "groq",
    reason: state?.reason ?? `auto: ${providerChainOrder().join(" → ")} fallback chain`,
  };
}

export async function generateWithAuto(
  history: HistoryTurn[],
  tools: ToolDef[],
  system: string,
  opts?: GenerateOpts
): Promise<{ response: LlmResponse; provider: string; handoff?: string }> {
  const mode = process.env.AGENT_LLM_PROVIDER || "auto";

  // v5.2 — FORCED offline mode: the deterministic local engine only,
  // zero network. Set AGENT_LLM_PROVIDER=offline in .env.
  if (mode === "offline") {
    const { offlineGenerate, offlineEngineEnabled } = await import("./offline");
    if (!offlineEngineEnabled()) throw new NoLlmProviderError(buildNoProviderMessage(null));
    return {
      response: await offlineGenerate(history, tools, system),
      provider: "offline",
    };
  }

  if (mode === "zai") {
    if (!(await zaiAvailable())) throw new NoLlmProviderError(buildNoProviderMessage(null));
    try {
      return { response: await zaiGenerateWithRetry(history, tools, system), provider: "zai" };
    } catch (e) {
      // forced-zai must fail with the actionable message, never the raw SDK error
      throw new NoLlmProviderError(
        buildNoProviderMessage(null, [`zai: ${(e as Error).message?.slice(0, 160) ?? "unavailable"}`])
      );
    }
  }
  if (mode === "groq") {
    if (!groqKey()) throw new NoLlmProviderError(buildNoProviderMessage("groq"));
    return { response: await groqProvider.generate(history, tools, system, opts), provider: "groq" };
  }
  if (mode === "openrouter") {
    if (!openrouterKey()) throw new NoLlmProviderError(buildNoProviderMessage("openrouter"));
    return { response: await openrouterProvider.generate(history, tools, system, opts), provider: "openrouter" };
  }
  if (mode === "explabs") {
    // v4.3 — the Experiential Labs gateway is forced: one xpl_ key,
    // the EXPLABS_MODELS waterfall, nothing else.
    if (!explabsKey()) throw new NoLlmProviderError(buildNoProviderMessage("explabs"));
    return { response: await explabsProvider.generate(history, tools, system, opts), provider: "explabs" };
  }
  if (mode === "freechain") {
    // v4.2 — the zero-cost relay is forced: free models only.
    if (!openrouterKey()) throw new NoLlmProviderError(buildNoProviderMessage("freechain"));
    return { response: await freechainProvider.generate(history, tools, system, opts), provider: "freechain" };
  }
  if (mode === "ollama") {
    if (!(await ollamaAvailable())) throw new NoLlmProviderError(buildNoProviderMessage("ollama"));
    return { response: await ollamaProvider.generate(history, tools, system, opts), provider: "ollama" };
  }
  if (mode === "nvidia") {
    if (!nvidiaKey()) throw new NoLlmProviderError(buildNoProviderMessage("nvidia"));
    return { response: await nvidiaProvider.generate(history, tools, system, opts), provider: "nvidia" };
  }
  if (mode === "glm") {
    if (!glmKey()) throw new NoLlmProviderError(buildNoProviderMessage("glm"));
    return { response: await glmProvider.generate(history, tools, system, opts), provider: "glm" };
  }
  if (mode === "gemini") {
    if (!geminiKey()) throw new NoLlmProviderError(buildNoProviderMessage("gemini"));
    return { response: await geminiGenerate(history, tools, system), provider: "gemini" };
  }
  if (mode === "openai") {
    if (!openaiKey()) throw new NoLlmProviderError(buildNoProviderMessage("openai"));
    return { response: await openaiGenerate(history, tools, system, opts), provider: "openai" };
  }

  // auto — ordered chain: MAIN model (toggle) first, then the registry
  // order. v4.2: groq → openrouter → freechain → nvidia → ollama →
  // glm → gemini → openai → zai, with the selected MAIN provider
  // moved to the front. When a provider's DAILY BUDGET is spent it
  // throws ProviderBudgetExhaustedError → the chain AUTO-TAKES-OVER
  // with the next provider (the "after 400" fallback server).
  // CRITICAL (fresh-install fix): z-ai is ONLY a candidate when its config
  // file actually exists on this machine. Without this guard, an install
  // with no keys falls through to ZAI.create(), whose raw SDK error
  // ("init failed: Configuration file not found…") becomes the run's error.
  const runFor: Record<Exclude<ProviderName, "zai" | "offline">, () => Promise<LlmResponse>> = {
    groq: () => groqProvider.generate(history, tools, system, opts),
    openrouter: () => openrouterProvider.generate(history, tools, system, opts),
    explabs: () => explabsProvider.generate(history, tools, system, opts),
    freechain: () => freechainProvider.generate(history, tools, system, opts),
    nvidia: () => nvidiaProvider.generate(history, tools, system, opts),
    ollama: () => ollamaProvider.generate(history, tools, system, opts),
    glm: () => glmProvider.generate(history, tools, system, opts),
    gemini: () => geminiGenerate(history, tools, system),
    openai: () => openaiGenerate(history, tools, system, opts),
  };
  const keyed = (name: ProviderName): boolean =>
    name === "groq" ? Boolean(groqKey())
    : name === "openrouter" ? Boolean(openrouterKey())
    : name === "explabs" ? Boolean(explabsKey())
    : name === "freechain" ? Boolean(openrouterKey()) // same key, :free models
    : name === "nvidia" ? Boolean(nvidiaKey())
    : name === "ollama" ? true // candidacy decided by the live probe below
    : name === "glm" ? Boolean(glmKey())
    : name === "gemini" ? Boolean(geminiKey())
    : name === "openai" ? Boolean(openaiKey())
    : false; // zai handled below

  const candidates: Array<{ name: ProviderName; run: () => Promise<LlmResponse> }> = [];
  for (const name of providerChainOrder()) {
    if (name === "zai") continue;
    if (name === "offline") continue; // handled explicitly below
    if (name === "ollama") {
      // v4.2 — local open-weights inference is a candidate only when
      // the Ollama daemon actually answers (probe cached 60s).
      if (await ollamaAvailable()) candidates.push({ name, run: runFor.ollama });
      continue;
    }
    if (keyed(name)) candidates.push({ name, run: runFor[name] });
  }
  if (await zaiAvailable()) candidates.push({ name: "zai", run: () => zaiGenerateWithRetry(history, tools, system) });

  // v5.2 — NETWORK GATE + OFFLINE SHORT-CIRCUIT (the anti-lag fix):
  // when the machine is offline (1.5s probe, cached 30s) or no key is
  // configured at all, the cloud chain is skipped ENTIRELY — the old
  // behavior burned the full 120s deadline on per-provider timeouts,
  // which the user saw as "lagging and failing". The local engine
  // answers instantly instead and offline coding goals still create
  // real files on disk.
  const { offlineGenerate, offlineEngineEnabled, probeNetwork } = await import("./offline");
  const useOfflineFallback = offlineEngineEnabled();
  const netUp = useOfflineFallback ? await probeNetwork() : true;
  if (!netUp || candidates.length === 0) {
    if (useOfflineFallback) {
      setAutoState("offline", netUp ? "local engine (no provider key configured)" : "local engine (offline — network unreachable, cloud providers skipped)");
      return {
        response: await offlineGenerate(history, tools, system),
        provider: "offline",
        ...(candidates.length > 0
          ? { handoff: `network unreachable after probe — the Entropy Local Engine took over instantly (no per-provider timeout lag), memory preserved.` }
          : {}),
      };
    }
    // No key in .env AND no .z-ai-config AND no offline engine → fail with the FIX.
    throw new NoLlmProviderError(buildNoProviderMessage(null));
  }

  // v4.1 — an explicit MAIN-model toggle always starts at the user's
  // selection; the memo only sticks when the chain is left on auto.
  const mainPref = getRuntimeLlmPrefs().mainProvider;
  const memo = getAutoState();
  let startIdx = 0;
  if (!mainPref && memo) {
    const idx = candidates.findIndex((c) => c.name === memo.active);
    if (idx >= 0) startIdx = idx;
  }
  if (mainPref) {
    const idx = candidates.findIndex((c) => c.name === mainPref);
    if (idx >= 0) startIdx = idx;
  }

  let lastError: unknown = null;
  // v4.4 — RELAY ROUNDS ("1 fails → 2 → 3 … → N → back to 1"): one
  // pass through the chain is a ROUND, not the end of the run. After
  // a full pass in which every provider refused (or tripped its
  // breaker), the engine waits an exponentially-growing, full-jitter
  // delay and rotates again from the front — a provider that rejected
  // a request gets a fresh turn once the others had theirs. Only the
  // chain deadline (default 120s, env AGENT_CHAIN_DEADLINE_MS; 0-round
  // cap via AGENT_CHAIN_ROUNDS) ends the rotation, with a full
  // per-provider diagnosis — and the coding runner's patience layer
  // then HOLDS the run and retries the whole relay (30s/60s/120s).
  // The chain never dead-ends while any provider can still answer.
  const roundBaseMs = envPositiveInt("AGENT_CHAIN_ROUND_BASE_MS", 2000);
  const roundMaxMs = Math.max(roundBaseMs, envPositiveInt("AGENT_CHAIN_ROUND_MAX_MS", 30_000));
  const chainDeadlineMs = envPositiveInt("AGENT_CHAIN_DEADLINE_MS", 120_000);
  const maxRounds = Math.max(0, Number(process.env.AGENT_CHAIN_ROUNDS ?? "") || 0); // 0 = unlimited, deadline rules
  const chainStartedAt = Date.now();
  let failures: string[] = []; // fresh diagnosis per round
  for (let round = 1; ; round++) {
    failures = [];
    for (let k = 0; k < candidates.length; k++) {
      if (Date.now() - chainStartedAt > chainDeadlineMs) break; // bound slow rounds too
      const cand = candidates[(startIdx + k) % candidates.length];
      try {
        const response = await cand.run();
        // v3.7 HANDOFF detection: the memoized provider was active in a
        // PREVIOUS round and a different one just succeeded → the model
        // died mid-run and the chain continued. Surface it so the runner
        // can show "memory preserved, coding continues" in the transcript.
        const handoff =
          memo && memo.active !== cand.name
            ? `${memo.active} stopped working (${lastError instanceof Error ? lastError.message.slice(0, 120) : "unavailable"}) → ${cand.name} took over with the full conversation memory preserved — the run continues safely.`
            : undefined;
        if (round === 1 && k === 0) {
          setAutoState(cand.name, memo?.active === cand.name ? memo.reason : `${cand.name} responding`);
        } else {
          const why = lastError instanceof Error ? lastError.message.slice(0, 120) : "unavailable";
          setAutoState(cand.name, `fallback after ${cand.name === "zai" ? "primary providers" : "previous provider"} issue (${why})`);
        }
        return { response, provider: cand.name, ...(handoff ? { handoff } : {}) };
      } catch (e) {
        lastError = e;
        failures.push(`${cand.name}: ${(e as Error).message?.slice(0, 160) ?? "unavailable"}`);
        // v4.2 — BUDGET AUTO-TAKEOVER: the provider's daily request
        // budget is spent (default 400/day). Loudly announce which
        // provider takes over and continue the chain — the task
        // ALWAYS completes; the counters reset at UTC midnight.
        if (e instanceof ProviderBudgetExhaustedError) {
          const nextCand = candidates[(startIdx + k + 1) % candidates.length];
          announceBudget(
            `${cand.name} daily budget exhausted (${e.budget.used}/${e.budget.limit}) — ${nextCand ? nextCand.name : "the next provider"} takes over automatically with the memory preserved; resets at UTC midnight.`
          );
          continue;
        }
        // v4.1 — circuit-open (skipped) and unavailable providers just
        // fall through to the next candidate.
        if (e instanceof ProviderUnavailableError) continue;
        if (e instanceof LlmCircuitOpenError) continue;
        // v4.4 — NO hard kill. A request one provider rejects as
        // "malformed" (HTTP 400) can be perfectly valid for the next —
        // providers differ in schemas, limits and tool-call formats.
        // Record it and keep rotating; the round deadline bounds the
        // loop and the final diagnosis carries the per-provider 400s.
        continue;
      }
    }
    if (maxRounds > 0 && round >= maxRounds) break;
    if (Date.now() - chainStartedAt > chainDeadlineMs) break;
    const exp = Math.min(roundBaseMs * Math.pow(2, round - 1), roundMaxMs);
    const waitMs = Math.floor(exp / 2 + Math.random() * (exp / 2)); // full jitter (tenacity)
    const nextFirst = candidates[startIdx % candidates.length].name;
    announceRelay(
      `relay round ${round + 1}${maxRounds > 0 ? `/${maxRounds}` : ""}: all ${candidates.length} providers refused this request — holding the memory safe, waiting ${(waitMs / 1000).toFixed(1)}s, then rotating back to ${nextFirst}. The run never dead-ends.`
    );
    await sleepMs(waitMs);
  }
  // Every configured provider refused for the whole deadline window
  // (bad keys, quota, outage…). v5.2 — the chain NEVER dead-ends: the
  // Entropy Local Engine answers as the terminal fallback, so the run
  // still produces a useful result (and offline coding goals still
  // write real files). Only with OFFLINE_ENGINE=0 does the run fail
  // with the per-provider diagnosis + fix.
  if (offlineEngineEnabled()) {
    setAutoState("offline", "local engine — every cloud provider refused (see failures above), answering locally");
    return {
      response: await offlineGenerate(history, tools, system),
      provider: "offline",
      handoff: `all ${candidates.length} cloud providers refused for the chain deadline — the Entropy Local Engine took over with the conversation preserved. Run continues offline.`,
    };
  }
  throw new NoLlmProviderError(buildNoProviderMessage(null, failures));
}

// ═════════════════════════════════════════════════════════════
// Provider HEALTH CHECK (non-throwing) — powers /api/agent/health,
// the MCP agent_health tool and the UI preflight card. This is
// what makes the suite reliable for OTHER users: instead of a
// silent "no provider" failure when no key is configured, every
// surface shows exactly which provider is ready and what to do.
// ═════════════════════════════════════════════════════════════

export interface ProviderStatus {
  name: ProviderName;
  configured: boolean;
  detail: string;
  hint?: string;
}

// ── .z-ai-config existence probe (cached 60s on globalThis) ──
// The z-ai SDK only works where a VALID .z-ai-config file exists (the build
// sandbox). Probing BEFORE calling ZAI.create() means a normal user's
// machine never hits the SDK's cryptic init error. Env overrides:
//   AGENT_DISABLE_ZAI=1  → force-off (tests / strict setups)
//   ZAI_CONFIG_PATH=…    → point at a custom config location
const ZAI_PROBE_KEY = "__agentZaiProbe";
const ZAI_PROBE_TTL_MS = 60 * 1000;

// The SDK's raw init error tells users to "create .z-ai-config" — advice
// that is only correct inside the build sandbox and actively harmful
// elsewhere: real users create an EMPTY file, which then fails as
// "invalid" and the cryptic error loops forever. Translate it instead.
const ZAI_INIT_BAD_CONFIG_RE = /Configuration file not found or invalid/i;

export function translateZaiInitError(e: unknown): string {
  const raw = (e as Error).message ?? String(e);
  if (ZAI_INIT_BAD_CONFIG_RE.test(raw)) {
    return "z-ai fallback unavailable (no valid .z-ai-config on this machine — that fallback is build-sandbox-only). Use a FREE Gemini key instead: https://aistudio.google.com/apikey → GEMINI_API_KEY=… in .env";
  }
  return `z-ai init failed: ${raw.slice(0, 120)}`;
}

export async function zaiConfigPath(): Promise<string | null> {
  if (env("AGENT_DISABLE_ZAI") === "1") return null;
  const { promises: fsp } = await import("node:fs");
  /** A config path only counts when the file parses AND carries the fields
   *  the SDK requires — existence alone is not enough (users create empty
   *  files when an old error told them to). */
  const validConfig = async (p: string): Promise<boolean> => {
    try {
      const text = await fsp.readFile(p, "utf8");
      const conf = JSON.parse(text) as { baseUrl?: string; apiKey?: string };
      return Boolean(conf.baseUrl && conf.apiKey);
    } catch {
      return false;
    }
  };
  const custom = env("ZAI_CONFIG_PATH");
  if (custom) {
    return (await validConfig(custom)) ? custom : null;
  }
  const g = globalThis as Record<string, unknown>;
  const cached = g[ZAI_PROBE_KEY] as { path: string | null; at: number } | undefined;
  if (cached && Date.now() - cached.at < ZAI_PROBE_TTL_MS) return cached.path;
  const os = await import("node:os");
  const candidates = [
    "./.z-ai-config",
    `${os.homedir()}/.z-ai-config`,
    "/etc/.z-ai-config",
  ];
  let found: string | null = null;
  for (const p of candidates) {
    if (await validConfig(p)) {
      found = p;
      break;
    }
  }
  g[ZAI_PROBE_KEY] = { path: found, at: Date.now() };
  return found;
}

async function zaiAvailable(): Promise<boolean> {
  return (await zaiConfigPath()) !== null;
}

/**
 * Last-resort translation for anything a runner catches at the top level.
 * If the error IS or CONTAINS the z-ai SDK's cryptic init error ("init
 * failed: Configuration file not found…" / "Please create .z-ai-config"),
 * swap in the single actionable no-provider message — this is exactly the
 * failure real users hit on v3.1/v3.2 installs, and it must never render
 * raw again, from ANY code path, on ANY version surface.
 */
export function diagnoseRunError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e ?? "unknown error");
  if (e instanceof NoLlmProviderError) return message;
  if (/z-ai-config|init failed:/i.test(message)) {
    return buildNoProviderMessage(null, [message.slice(0, 160)]);
  }
  return message;
}

/**
 * The single actionable message shown whenever NO usable provider exists.
 * Used by generateWithAuto, both runner preflights, /api/agent/health and
 * the MCP agent_health tool — one voice everywhere.
 */
export function buildNoProviderMessage(
  forced: ProviderName | null,
  failures?: string[]
): string {
  const lines: string[] = [];
  if (failures && failures.length > 0) {
    lines.push("NO LLM PROVIDER RESPONDED — every configured provider failed:");
    for (const f of failures) {
      // sanitize: never let the SDK's "create .z-ai-config" advice render
      const safe = ZAI_INIT_BAD_CONFIG_RE.test(f)
        ? "z-ai fallback unavailable (no valid .z-ai-config — sandbox-only). Use a Gemini or OpenAI key in .env"
        : f;
      lines.push(`  • ${safe}`);
    }
    lines.push("");
    lines.push("Check the key(s) for typos, quota, and billing. Common causes: pasted the wrong key, free-tier quota exhausted, or no internet.");
  } else {
    lines.push("NO LLM PROVIDER CONFIGURED — the agent cannot think without at least one API key.");
  }
  lines.push("");
  if (forced === "openai") {
    lines.push("Fix (openai is forced via AGENT_LLM_PROVIDER): set OPENAI_API_KEY in the .env file inside the project folder, then restart the server.");
  } else if (forced === "gemini") {
    lines.push("Fix (gemini is forced via AGENT_LLM_PROVIDER): set GEMINI_API_KEY in the .env file inside the project folder, then restart the server.");
  } else if (forced === "groq") {
    lines.push("Fix (groq is forced via AGENT_LLM_PROVIDER): set GROQ_API_KEY in the .env file inside the project folder (FREE key: https://console.groq.com/keys), then restart the server.");
  } else if (forced === "glm") {
    lines.push("Fix (glm is forced via AGENT_LLM_PROVIDER): set GLM_API_KEY in the .env file inside the project folder (key from https://z.ai → API keys), then restart the server.");
  } else if (forced === "openrouter") {
    lines.push("Fix (openrouter is forced via AGENT_LLM_PROVIDER): set OPENROUTER_API_KEY (sk-or-v1-…, https://openrouter.ai → Keys) in the .env file, then restart the server.");
  } else if (forced === "explabs") {
    lines.push("Fix (explabs is forced via AGENT_LLM_PROVIDER): set EXPLABS_API_KEY (xpl_…, https://platform.experientiallabs.ai → Settings → API keys) in the .env file — one key reaches 313 models (minimax-m2.7-free costs $0), then restart the server.");
  } else if (forced === "freechain") {
    lines.push("Fix (freechain is forced via AGENT_LLM_PROVIDER): set OPENROUTER_API_KEY (sk-or-v1-…, https://openrouter.ai → Keys) in the .env file — :free models cost $0 on ANY OpenRouter key (even with zero credits), then restart the server.");
  } else if (forced === "ollama") {
    lines.push("Fix (ollama is forced via AGENT_LLM_PROVIDER): install Ollama (https://ollama.com), run `ollama pull qwen2.5-coder:7b`, make sure it answers at OLLAMA_BASE_URL (default http://127.0.0.1:11434), then restart the server.");
  } else if (forced === "nvidia") {
    lines.push("Fix (nvidia is forced via AGENT_LLM_PROVIDER): set NVIDIA_API_KEY (nvapi-…, https://build.nvidia.com → Get API Key) in the .env file, then restart the server.");
  } else {
    lines.push("HOW TO FIX (2 minutes, free):");
    lines.push("  1. Get a FREE Groq key (RECOMMENDED — fast, generous limits, openai/gpt-oss-120b): https://console.groq.com/keys → copy it");
    lines.push("     …or an OpenRouter key (430+ models; :free models like poolside/laguna-s-2.1:free cost $0 even with zero credits): https://openrouter.ai → Keys");
    lines.push("     …or an Experiential Labs key (xpl_… — 313-model gateway, minimax-m2.7-free is $0): https://platform.experientiallabs.ai/settings/api-keys");
    lines.push("     …or run Ollama locally (qwen2.5-coder — zero cost, no key, offline): https://ollama.com");
    lines.push("     …or a FREE Gemini key: https://aistudio.google.com/apikey");
    lines.push("  2. Open the .env file in the project folder and set (create the line if missing):");
    lines.push("       GROQ_API_KEY=your-groq-key         (primary — model openai/gpt-oss-120b)");
    lines.push("       OPENROUTER_API_KEY=sk-or-v1-…       (GLM-5.2 via OpenRouter — model z-ai/glm-5.2)");
    lines.push("       EXPLABS_API_KEY=xpl_…               (Experiential Labs gateway — 313 models)");
    lines.push("       NVIDIA_API_KEY=nvapi-…              (Nemotron-3-Ultra thinking model)");
    lines.push("       GEMINI_API_KEY=your-gemini-key      (optional fallback)");
    lines.push("  3. Restart the server (close this window and run install.bat / install.sh again — your keys are KEPT)");
    lines.push("  4. Click 'Recheck' on the Agent tab preflight card, then re-run the goal");
  }
  lines.push("");
  lines.push("Model toggle: pick the MAIN model (Groq / GLM 5.2 / Ex Labs / Free Chain / Nemotron / Ollama local) in the console — the rest become ordered fallbacks with failover memory + daily-budget auto-takeover.");
  lines.push("The dashboard itself (tracker, feeds, JD match) works without any key — only the autonomous agent needs one.");
  return lines.join("\n");
}

/** Shared runner preflight: fail FAST + actionable before burning a round. */
export async function assertProviderConfigured(): Promise<{
  ok: boolean;
  message: string;
}> {
  const mode = env("AGENT_LLM_PROVIDER") || "auto";
  if (mode === "groq" && !groqKey()) {
    return { ok: false, message: buildNoProviderMessage("groq") };
  }
  if (mode === "openrouter" && !openrouterKey()) {
    return { ok: false, message: buildNoProviderMessage("openrouter") };
  }
  if (mode === "explabs" && !explabsKey()) {
    return { ok: false, message: buildNoProviderMessage("explabs") };
  }
  if (mode === "freechain" && !openrouterKey()) {
    return { ok: false, message: buildNoProviderMessage("freechain") };
  }
  if (mode === "ollama" && !(await ollamaAvailable())) {
    return { ok: false, message: buildNoProviderMessage("ollama") };
  }
  if (mode === "nvidia" && !nvidiaKey()) {
    return { ok: false, message: buildNoProviderMessage("nvidia") };
  }
  if (mode === "glm" && !glmKey()) {
    return { ok: false, message: buildNoProviderMessage("glm") };
  }
  if (mode === "gemini" && !geminiKey()) {
    return { ok: false, message: buildNoProviderMessage("gemini") };
  }
  if (mode === "openai" && !openaiKey()) {
    return { ok: false, message: buildNoProviderMessage("openai") };
  }
  if (mode === "zai" && !(await zaiAvailable())) {
    return { ok: false, message: buildNoProviderMessage(null) };
  }
  // v5.2 — the offline engine alone is enough to run: no key needed.
  if (mode === "offline") {
    const { offlineEngineEnabled } = await import("./offline");
    return offlineEngineEnabled()
      ? { ok: true, message: "" }
      : { ok: false, message: "AGENT_LLM_PROVIDER=offline but the local engine is disabled (OFFLINE_ENGINE=0). Remove that line or pick a provider." };
  }
  if (mode === "auto") {
    const { offlineEngineEnabled } = await import("./offline");
    const hasAny =
      groqKey() || openrouterKey() || explabsKey() || nvidiaKey() || glmKey() || geminiKey() || openaiKey() ||
      (await zaiAvailable()) || (await ollamaAvailable()) || offlineEngineEnabled();
    if (!hasAny) return { ok: false, message: buildNoProviderMessage(null) };
  }
  return { ok: true, message: "" };
}

export async function getProviderHealth(): Promise<{
  mode: string;
  providers: ProviderStatus[];
  anyConfigured: boolean;
  active: { provider: string; reason: string };
}> {
  const mode = process.env.AGENT_LLM_PROVIDER || "auto";
  const providers: ProviderStatus[] = [];

  providers.push(
    groqKey()
      ? { name: "groq", configured: true, detail: `GROQ_API_KEY set (model: ${groqModel()}, base: ${groqBase()}${/gpt-oss/i.test(groqModel()) ? `, reasoning_effort: ${groqReasoningEffort()}` : ""})` }
      : {
          name: "groq",
          configured: false,
          detail: "GROQ_API_KEY not set in .env",
          hint: "PRIMARY provider (v3.5). FREE key at https://console.groq.com/keys → GROQ_API_KEY=… — openai/gpt-oss-120b, fast, generous free tier (far fewer 429s than Gemini).",
        }
  );

  providers.push(
    glmKey()
      ? { name: "glm", configured: true, detail: `GLM_API_KEY set (model: ${glmModel()}, base: ${glmBase()})` }
      : {
          name: "glm",
          configured: false,
          detail: "GLM_API_KEY not set in .env",
          hint: "Z.ai GLM direct. Key from https://z.ai (also accepts ZAI_API_KEY); model glm-4.6. Coding-plan users: set GLM_API_BASE=https://api.z.ai/api/coding/paas/v4.",
        }
  );

  providers.push(
    geminiKey()
      ? { name: "gemini", configured: true, detail: `GEMINI_API_KEY set (model: ${geminiModel()})` }
      : {
          name: "gemini",
          configured: false,
          detail: "GEMINI_API_KEY not set in .env",
          hint: "Get a FREE key at https://aistudio.google.com/apikey and put it in .env — the fastest way to power the agent on your machine.",
        }
  );

  providers.push(
    openaiKey()
      ? { name: "openai", configured: true, detail: `OPENAI_API_KEY set (model: ${openaiModel()}, base: ${openaiBase()})` }
      : {
          name: "openai",
          configured: false,
          detail: "OPENAI_API_KEY not set in .env",
          hint: "Optional provider. Works with sk-proj- OpenAI keys AND any OpenAI-compatible endpoint (set OPENAI_BASE_URL for DeepSeek / Groq / OpenRouter).",
        }
  );

  // v4.1 — OpenRouter (GLM-5.2 main-model toggle) + NVIDIA NIM.
  providers.push(
    openrouterKey()
      ? { name: "openrouter", configured: true, detail: `OPENROUTER_API_KEY set (model: ${openrouterModel()}, base: ${openrouterBase()})` }
      : {
          name: "openrouter",
          configured: false,
          detail: "OPENROUTER_API_KEY not set in .env",
          hint: "MAIN-MODEL toggle (v4.1) — one key, 430+ models. Default z-ai/glm-5.2 (GLM 5.2); reports exact USD cost per round. Key: https://openrouter.ai → Keys (sk-or-v1-…).",
        }
  );

  providers.push(
    nvidiaKey()
      ? {
          name: "nvidia",
          configured: true,
          detail: `NVIDIA_API_KEY set (model: ${nvidiaModel()}, base: ${nvidiaBase()}, enable_thinking: ${nvidiaThinking() ? "on" : "off"})`,
        }
      : {
          name: "nvidia",
          configured: false,
          detail: "NVIDIA_API_KEY not set in .env",
          hint: "MAIN-MODEL toggle (v4.1) — NVIDIA NIM build.nvidia.com. nemotron-3-ultra-550b thinking model; streams reasoning_content live. Key: https://build.nvidia.com → Get API Key (nvapi-…).",
        }
  );

  // v4.3 — Experiential Labs gateway (one xpl_ key → 313 models).
  const xplModels = explabsModels();
  providers.push(
    explabsKey()
      ? {
          name: "explabs",
          configured: true,
          detail: `EXPLABS_API_KEY set — ${explabsBase()} · waterfall: ${xplModels.join(" → ")} (minimax-m2.7-free is $0)`,
        }
      : {
          name: "explabs",
          configured: false,
          detail: "EXPLABS_API_KEY not set in .env",
          hint: "MAIN-MODEL toggle (v4.3) — Experiential Labs gateway: ONE xpl_ key → 313 models (Claude/GPT/GLM/Gemini/Qwen/Nemotron…) at https://api.experientiallabs.ai/v1, each with its own provider waterfall. minimax-m2.7-free costs $0 and does native tool calling. Key: https://platform.experientiallabs.ai/settings/api-keys (xpl_ + 40 hex).",
        }
  );

  // v4.2 — FREE-CHAIN (OpenRouter :free relay) + local Ollama.
  const freeModels = openrouterFreeModels();
  const freeLimit = budgetLimitFor("freechain:demo");
  providers.push(
    openrouterKey()
      ? {
          name: "freechain",
          configured: true,
          detail: `OPENROUTER_API_KEY set — zero-cost relay: ${freeModels.join(" → ")}`,
        }
      : {
          name: "freechain",
          configured: false,
          detail: "OPENROUTER_API_KEY not set in .env",
          hint: `FREE-CHAIN toggle (v4.2) — ${freeModels.join(" → ")}. Zero cost on ANY OpenRouter key (works with zero credits); each model ≈${freeLimit} req/day, auto-rotation on 429/402. Set OPENROUTER_API_KEY (https://openrouter.ai → Keys, sk-or-v1-…).`,
        }
  );
  const ollamaOk = await ollamaAvailable();
  providers.push(
    ollamaOk
      ? {
          name: "ollama",
          configured: true,
          detail: `Ollama reachable at ${ollamaBase()} (model: ${ollamaModel()}) — local open-weights, unlimited, offline`,
        }
      : {
          name: "ollama",
          configured: false,
          detail: `not reachable at ${ollamaBase()}`,
          hint: "LOCAL zero-cost toggle (v4.2). Install Ollama (https://ollama.com) → `ollama pull qwen2.5-coder:7b` — no key, no rate limits, offline. Set OLLAMA_BASE_URL / OLLAMA_MODEL to customize (vLLM & LM Studio work too).",
        }
  );

  const zaiPath = await zaiConfigPath();
  providers.push(
    zaiPath
      ? { name: "zai", configured: true, detail: `.z-ai-config found (${zaiPath})` }
      : {
          name: "zai",
          configured: false,
          detail: "no .z-ai-config file (searched project, home, /etc)",
          hint: "Only present in the build sandbox. On your own machine rely on the other providers in .env.",
        }
  );

  // v5.2 — the ENTROPY LOCAL ENGINE: deterministic offline fallback.
  // It answers when no key is configured OR the network is down, and
  // offline coding goals still create real files on disk. OFFLINE_ENGINE=0
  // in .env disables it (runs then hard-fail with the fix message).
  const { offlineEngineEnabled, probeNetwork, OFFLINE_ENGINE_VERSION } = await import("./offline");
  const offlineOn = offlineEngineEnabled();
  const netUp = offlineOn ? await probeNetwork() : false;
  providers.push(
    offlineOn
      ? {
          name: "offline",
          configured: true,
          detail: `Entropy Local Engine v${OFFLINE_ENGINE_VERSION} armed — ${
            netUp
              ? "network reachable; answers only if every cloud provider fails"
              : "OFFLINE detected — takes over instantly (no timeout lag), writes real files"
          }`,
        }
      : {
          name: "offline",
          configured: false,
          detail: "OFFLINE_ENGINE=0 — disabled in .env",
          hint: "Deterministic no-network engine: keeps the agent answering and creating files with zero keys / zero internet. Remove OFFLINE_ENGINE=0 to re-arm.",
        }
  );

  // v4.1 — order the health list as the actual chain (main first).
  // v5.2 — "offline" always sorts LAST (it is the terminal fallback).
  const order = providerChainOrder();
  providers.sort((a, b) => {
    const ai = a.name === "offline" ? order.length : order.indexOf(a.name);
    const bi = b.name === "offline" ? order.length : order.indexOf(b.name);
    return ai - bi;
  });

  return {
    mode,
    providers,
    anyConfigured: providers.some((p) => p.configured),
    active: getActiveProviderInfo(),
  };
}
