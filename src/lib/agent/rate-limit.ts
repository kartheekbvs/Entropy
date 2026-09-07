// ─────────────────────────────────────────────────────────────
// Token-bucket rate limiting for every agent action — the same
// discipline Claude Code applies to tool + LLM calls.
//
// Buckets (requests per minute, env-tunable):
//   llm    — LLM generate calls          (default 15/min)
//   tool   — tool executions             (default 60/min)
//   shell  — shell commands (extra)      (default 20/min)
//   mcp    — MCP client tool requests    (default 120/min)
//
// State lives on globalThis so Next.js HMR and the MCP server
// process keep consistent, independent counters.
// ─────────────────────────────────────────────────────────────

export type RateBucket = "llm" | "tool" | "shell" | "mcp";

export interface RateLimitResult {
  allowed: boolean;
  bucket: RateBucket;
  remaining: number;
  retryAfterMs: number; // 0 when allowed
}

const DEFAULTS: Record<RateBucket, number> = {
  llm: num(process.env.AGENT_RATE_LLM, 15),
  tool: num(process.env.AGENT_RATE_TOOL, 60),
  shell: num(process.env.AGENT_RATE_SHELL, 20),
  mcp: num(process.env.AGENT_RATE_MCP, 120),
};

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface BucketState {
  tokens: number; // fractional tokens available
  last: number; // ms epoch of last refill
}

const g = globalThis as unknown as { __rateBuckets?: Map<string, BucketState> };
if (!g.__rateBuckets) g.__rateBuckets = new Map();
const buckets = g.__rateBuckets;

const CAPACITY = 3; // allow short bursts of up to 3× the per-minute rate

/** Consume one token from a bucket. Returns whether the call may proceed. */
export function rateLimit(bucket: RateBucket, id = "*"): RateLimitResult {
  const perMinute = DEFAULTS[bucket];
  const ratePerMs = perMinute / 60_000;
  const key = `${bucket}:${id}`;
  const now = Date.now();
  const state = buckets.get(key) ?? { tokens: CAPACITY * perMinute, last: now };
  // refill elapsed tokens
  state.tokens = Math.min(CAPACITY * perMinute, state.tokens + (now - state.last) * ratePerMs);
  state.last = now;

  if (state.tokens >= 1) {
    state.tokens -= 1;
    buckets.set(key, state);
    return { allowed: true, bucket, remaining: Math.floor(state.tokens), retryAfterMs: 0 };
  }
  buckets.set(key, state);
  const retryAfterMs = Math.ceil((1 - state.tokens) / ratePerMs);
  return { allowed: false, bucket, remaining: 0, retryAfterMs };
}

/** Thrown by callers that want exception semantics. */
export class RateLimitError extends Error {
  constructor(public result: RateLimitResult) {
    super(`rate limit reached for ${result.bucket} — retry in ${result.retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

/** Snapshot of live buckets (for the UI / MCP diagnostics). */
export function rateLimitStatus(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, s] of buckets) out[key] = Math.floor(s.tokens);
  return out;
}

/** Wait for a slot if limited (bounded). Returns true if a slot was acquired. */
export async function acquireWithWait(bucket: RateBucket, id = "*", maxWaitMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const r = rateLimit(bucket, id);
    if (r.allowed) return true;
    if (Date.now() + r.retryAfterMs > deadline) return false;
    await new Promise((res) => setTimeout(res, Math.min(r.retryAfterMs, 5_000)));
  }
}
