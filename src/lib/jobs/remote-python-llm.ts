/**
 * Remote Python Fresher Radar — AI ranking chain.
 *
 * Ranks the aggregated roles with an LLM and returns a fresher-fit
 * verdict + market summary. Provider chain (per the owner's spec):
 *
 *   1. Experiential Labs  (gpt-oss-120b FIRST, then gpt-oss-20b and the
 *      whole ExLabs waterfall: minimax-m2.7-free → kimi-k2.6 → glm-5.2
 *      → qwen3.6-flash)         ← "use all experiment labs"
 *   2. OpenRouter         (z-ai/glm-5.2 → gpt-oss-120b → :free relay)
 *   3. NVIDIA NIM         (nemotron-3-ultra, NIM-pinned sampling)
 *   4. Groq               (openai/gpt-oss-120b → 20b → llama-3.3)
 *                          ← LAST choice, per the owner's spec
 *
 * Wire quirks learned from live probing (see scripts/probe-remote-python*.mjs):
 *   • ExLabs gpt-oss-120b answers 403 model_location_not_supported from
 *     some regions — the chain rotates through the waterfall in ms.
 *   • ExLabs "-batch" slugs are Batch-API-only (404 on chat) — the live
 *     chat slug is gpt-oss-120b, which is what we wire.
 *   • ExLabs catalog is sampling-pinned: send a minimal body; if a model
 *     answers 400 invalid_parameter on max_tokens, retry once WITHOUT it.
 *   • NIM nemotron requires temperature=1 / top_p=0.95 (it 400s otherwise).
 *
 * If EVERY provider fails, the ranker degrades gracefully: the roles are
 * still returned with heuristic scores and a `degraded: true` note —
 * the radar never blocks on the LLM.
 */

import type { RemoteRole } from "./remote-python";

// ── types ─────────────────────────────────────────────────────

export interface AiVerdict {
  id: string;
  fit: "high" | "medium" | "low";
  score: number;
  reason: string;
}

export interface AiRankResult {
  verdicts: AiVerdict[];
  summary: string;
  provider: string;
  model: string;
  degraded: boolean;
  /** rotation trace, e.g. ["explabs/gpt-oss-120b: HTTP 403 (geo)", …] */
  notes: string[];
}

interface ChainStep {
  provider: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  /** step-level request shaping */
  quirks: {
    /** omit temperature/top_p (sampling-pinned catalog) */
    minimalBody?: boolean;
    /** force these sampling params (NIM nemotron requirement) */
    force?: { temperature: number; top_p: number };
    /** extra body fields */
    extraBody?: Record<string, unknown>;
    timeoutMs: number;
  };
}

// ── chain construction (env-driven, evaluated per call) ───────

// order matters: gpt-oss first (owner's spec), then fast models — the
// reasoning-style slugs (minimax/kimi/glm) can burn the whole output budget
// on thinking before emitting content, so they ride at the tail
const DEFAULT_EXPLABS_MODELS =
  "gpt-oss-120b,gpt-oss-20b,qwen3.6-flash,kimi-k2.6,glm-5.2,minimax-m2.7-free";

const list = (v: string | undefined, d: string): string[] =>
  (v ?? d)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function buildAiChain(): ChainStep[] {
  const steps: ChainStep[] = [];
  const explabsKey = process.env.EXPLABS_API_KEY;
  if (explabsKey) {
    steps.push({
      provider: "explabs",
      label: "Experiential Labs",
      baseUrl: process.env.EXPLABS_BASE_URL || "https://api.experientiallabs.ai/v1",
      apiKey: explabsKey,
      models: list(process.env.REMOTE_PYTHON_EXPLABS_MODELS, DEFAULT_EXPLABS_MODELS),
      quirks: { minimalBody: true, timeoutMs: 45_000 },
    });
  }
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    steps.push({
      provider: "openrouter",
      label: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: orKey,
      models: [
        ...list(process.env.OPENROUTER_MODEL, "z-ai/glm-5.2"),
        "openai/gpt-oss-120b",
      ],
      quirks: { timeoutMs: 45_000 },
    });
    const free = list(
      process.env.OPENROUTER_FREE_MODELS,
      "poolside/laguna-s-2.1:free,nvidia/nemotron-3.5-lightning:free,dots-studio/dots3-note-preview:free"
    );
    if (free.length) {
      steps.push({
        provider: "freechain",
        label: "OpenRouter free relay",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: orKey,
        models: free,
        quirks: { timeoutMs: 45_000 },
      });
    }
  }
  const nvKey = process.env.NVIDIA_API_KEY;
  if (nvKey) {
    steps.push({
      provider: "nvidia",
      label: "NVIDIA NIM",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: nvKey,
      models: list(process.env.NVIDIA_MODEL, "nvidia/nemotron-3-ultra-550b-a55b"),
      quirks: {
        force: { temperature: 1, top_p: 0.95 },
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
        timeoutMs: 60_000,
      },
    });
  }
  // Groq — the owner's LAST choice. Models match the Groq catalog
  // (openai/gpt-oss-120b primary; llama fallback).
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    steps.push({
      provider: "groq",
      label: "Groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: groqKey,
      models: list(
        process.env.REMOTE_PYTHON_GROQ_MODELS,
        "openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile"
      ),
      quirks: { timeoutMs: 45_000 },
    });
  }
  return steps;
}

// ── prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You rank remote Python developer jobs for an absolute fresher: a recent " +
  "graduate with 0-1 years of professional experience, strong Python " +
  "fundamentals, ML/AI coursework, and personal projects. You are strict: " +
  "roles demanding 2+ years of professional experience are MEDIUM at best. " +
  "Worldwide-open roles rank above region-locked ones. Reply ONLY with JSON.";

function buildUserPrompt(roles: RemoteRole[]): string {
  const compact = roles.map((r) => ({
    id: r.id,
    title: r.title.slice(0, 80),
    company: (r.company || "").slice(0, 40),
    location: r.location.slice(0, 40),
    worldwide: r.worldwide,
    tags: r.tags.slice(0, 5),
    postedDaysAgo: r.ageDays,
    heurFlags: r.fresherFlags.slice(0, 4),
  }));
  return (
    "Rank these ACTIVE remote Python roles by fresher suitability. " +
    'Reply with JSON only, shape: {"ranked":[{"id":"<id>","fit":"high|medium|low",' +
    '"score":0-10,"reason":"<=10 words"}],"summary":"<=22 words on the current ' +
    "remote-Python market for freshers\"}\n\nRoles:\n" +
    JSON.stringify(compact)
  );
}

// ── robust JSON extraction ────────────────────────────────────

export function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  const slice = t.slice(first, last + 1);
  try {
    const parsed = JSON.parse(slice);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    // second chance: JSON with trailing commas / smart quotes
    try {
      const repaired = slice
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'");
      const parsed = JSON.parse(repaired);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}

// ── single chat attempt ───────────────────────────────────────

interface AttemptOut {
  ok: boolean;
  content: string;
  status?: number;
  error?: string;
}

async function chatOnce(
  step: ChainStep,
  model: string,
  system: string,
  user: string,
  dropMaxTokens: boolean,
  fetcher: typeof fetch
): Promise<AttemptOut> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 1600,
  };
  if (dropMaxTokens) delete body.max_tokens;
  if (step.quirks.force) {
    body.temperature = step.quirks.force.temperature;
    body.top_p = step.quirks.force.top_p;
  } else if (!step.quirks.minimalBody) {
    body.temperature = 0.2;
  }
  if (step.quirks.extraBody) Object.assign(body, step.quirks.extraBody);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), step.quirks.timeoutMs);
  try {
    const res = await fetcher(`${step.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${step.apiKey}`,
        "Content-Type": "application/json",
        ...(step.provider === "openrouter" || step.provider === "freechain"
          ? { "HTTP-Referer": "https://github.com/job-command-center", "X-Title": "Job Command Center" }
          : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        const m = j?.error?.message ?? j?.message ?? j?.detail;
        if (typeof m === "string") msg += ` ${m.slice(0, 90)}`;
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, content: "", status: res.status, error: msg };
    }
    let content = "";
    let finish = "";
    let reasoningTokens = 0;
    try {
      const j = JSON.parse(text);
      const msg = j?.choices?.[0]?.message ?? {};
      finish = String(j?.choices?.[0]?.finish_reason ?? "");
      reasoningTokens = Number(j?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
      // content OR reasoning_content (reasoning-only models put the payload there)
      content = String(msg.content ?? msg.reasoning_content ?? "");
    } catch {
      return { ok: false, content: "", status: res.status, error: "invalid JSON response" };
    }
    if (!content.trim()) {
      return {
        ok: false,
        content: "",
        status: res.status,
        error:
          finish === "length"
            ? `reasoning burn (finish=length, ${reasoningTokens} thinking tokens, no content)`
            : "empty completion",
      };
    }
    return { ok: true, content };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message.slice(0, 90)) : "network error";
    return { ok: false, content: "", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ── chain runner ──────────────────────────────────────────────

function parseVerdicts(
  json: Record<string, unknown>,
  roles: RemoteRole[]
): { verdicts: AiVerdict[]; summary: string } {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const verdicts: AiVerdict[] = [];
  const ranked = Array.isArray(json.ranked) ? json.ranked : [];
  for (const v of ranked) {
    if (typeof v !== "object" || v === null) continue;
    const id = String((v as Record<string, unknown>).id ?? "");
    if (!id || !byId.has(id)) continue;
    const fitRaw = String((v as Record<string, unknown>).fit ?? "medium").toLowerCase();
    const fit: AiVerdict["fit"] =
      fitRaw === "high" || fitRaw === "low" ? fitRaw : "medium";
    const score = Number((v as Record<string, unknown>).score);
    verdicts.push({
      id,
      fit,
      score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 5,
      reason: String((v as Record<string, unknown>).reason ?? "").slice(0, 90),
    });
  }
  return { verdicts, summary: String(json.summary ?? "").slice(0, 180) };
}

interface AiCacheEntry {
  key: string;
  at: number;
  result: AiRankResult;
}

let aiCache: AiCacheEntry | null = null;

/** test hook — drop the verdict cache */
export function __resetRemotePythonAiCache(): void {
  aiCache = null;
}

export interface RankAiOptions {
  fetcher?: typeof fetch;
  /** skip the LLM entirely (heuristic-only mode) */
  disabled?: boolean;
}

/**
 * Rank `roles` through the provider chain. NEVER throws — the worst case
 * is a degraded result that keeps the heuristic ordering intact.
 */
export async function rankRemoteRolesWithAI(
  roles: RemoteRole[],
  opts: RankAiOptions = {}
): Promise<AiRankResult> {
  const empty: AiRankResult = {
    verdicts: [],
    summary: "",
    provider: "heuristic",
    model: "none",
    degraded: true,
    notes: [],
  };
  if (opts.disabled || roles.length === 0) {
    return { ...empty, notes: opts.disabled ? ["AI ranking disabled (?ai=0)"] : ["no roles to rank"] };
  }

  const fetcher = opts.fetcher ?? globalThis.fetch;
  const chain = buildAiChain();
  if (chain.length === 0) {
    return { ...empty, notes: ["no provider keys configured (EXPLABS/GROQ/…)"] };
  }

  // verdict cache: identical role sets reuse the previous ranking for 5 min
  // (the boards themselves are cached 10 min upstream)
  const key = roles.map((r) => r.id).join("|");
  const now = Date.now();
  if (aiCache && aiCache.key === key && now - aiCache.at < 5 * 60_000 && !opts.disabled) {
    return aiCache.result;
  }

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(roles);
  const notes: string[] = [];

  for (const step of chain) {
    for (const model of step.models) {
      const first = await chatOnce(step, model, system, user, false, fetcher);
      if (first.ok) {
        const json = extractJson(first.content);
        if (json) {
          const { verdicts, summary } = parseVerdicts(json, roles);
          if (verdicts.length > 0) {
            const result: AiRankResult = { verdicts, summary, provider: step.provider, model, degraded: false, notes };
            aiCache = { key, at: Date.now(), result };
            return result;
          }
          notes.push(`${step.provider}/${model}: JSON had no valid verdicts`);
          continue;
        }
        notes.push(`${step.provider}/${model}: unparseable JSON reply`);
        continue;
      }
      // minimal-body recovery: 400 invalid_parameter → retry without max_tokens
      if (first.status === 400 && /invalid[_\s]?param|max_tokens|unsupported/i.test(first.error ?? "")) {
        const retry = await chatOnce(step, model, system, user, true, fetcher);
        if (retry.ok) {
          const json = extractJson(retry.content);
          if (json) {
            const { verdicts, summary } = parseVerdicts(json, roles);
            if (verdicts.length > 0) {
              notes.push(`${step.provider}/${model}: minimal-body retry succeeded`);
              const result: AiRankResult = { verdicts, summary, provider: step.provider, model, degraded: false, notes };
              aiCache = { key, at: Date.now(), result };
              return result;
            }
          }
        }
        notes.push(`${step.provider}/${model}: ${retry.error ?? first.error} (minimal-body retry failed)`);
        continue;
      }
      notes.push(`${step.provider}/${model}: ${first.error}`);
    }
  }
  return { ...empty, notes: [...notes, "all providers exhausted — heuristic ranking"] };
}

/** merge AI verdicts onto roles (mutates copies, safe) */
export function applyVerdicts(
  roles: RemoteRole[],
  result: AiRankResult
): RemoteRole[] {
  const byId = new Map(result.verdicts.map((v) => [v.id, v]));
  const merged = roles.map((r) => {
    const v = byId.get(r.id);
    if (!v) return { ...r };
    return { ...r, aiFit: v.fit, aiScore: v.score, aiReason: v.reason };
  });
  // AI fit ordering: high > medium > low, stable within bands
  const order = { high: 0, medium: 1, low: 2 } as const;
  if (!result.degraded) {
    merged.sort((a, b) => {
      const fa = a.aiFit ? order[a.aiFit] : 3;
      const fb = b.aiFit ? order[b.aiFit] : 3;
      return fa - fb || (b.aiScore ?? 0) - (a.aiScore ?? 0) || b.fresherScore - a.fresherScore;
    });
  }
  return merged;
}
