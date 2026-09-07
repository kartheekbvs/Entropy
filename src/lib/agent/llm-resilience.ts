// ─────────────────────────────────────────────────────────────
// v4.1 REQUEST QUEUING & BACKOFF — tenacity/backoff-style LLM
// transport resilience (the Python-library discipline, native TS).
//
// WHY: real providers fail in specific, well-known ways —
//   • Groq / NVIDIA / OpenRouter answer 429 with a Retry-After
//     header ("try again in 7.017s") that MUST be honored
//   • NVIDIA NIM answers HTTP 200 and then embeds
//     {"error":{"code":503,"message":"Service temporarily
//     overloaded"}} INSIDE the SSE stream (verified live) — a naive
//     parser returns an empty response instead of retrying
//   • bursts (autopilot + manual run + MCP) can overlap and slam
//     one provider concurrently
//
// WHAT (all three resilience layers, per provider):
//   1. QUEUE      — per-provider FIFO: one in-flight LLM request at
//                  a time, everyone else waits its turn (fair order,
//                  no starvation). Depth is reported live to the UI.
//   2. BACKOFF    — exponential with FULL jitter
//                  (tenacity "wait_exponential_jitter"): attempt n
//                  waits min(base·2ⁿ⁻¹, max) with uniform jitter.
//                  Retry-After (seconds float or HTTP-date) OVERRIDES
//                  the computed delay; absurd values (> 45s) trip a
//                  fast-fallback instead of blocking the run.
//   3. BREAKER    — after N consecutive hard failures the provider's
//                  circuit opens for a cooldown: the chain skips it
//                  instantly (no wasted round-trips) and the first
//                  success after half-open closes it again.
//
// Every retry/wait/breaker transition is published to the agent
// event bus → the xterm.js console + UI badges render it LIVE.
//
// Env knobs (all optional):
//   AGENT_LLM_MAX_ATTEMPTS   (default 3)   attempts before failover
//   AGENT_LLM_BACKOFF_BASE_MS(1s)          first backoff delay
//   AGENT_LLM_BACKOFF_MAX_MS (30s)         backoff ceiling
//   AGENT_LLM_BREAKER_AFTER  (3)           consecutive failures to open
//   AGENT_LLM_BREAKER_MS     (90s)         open duration
// ─────────────────────────────────────────────────────────────

import { publish } from "./event-bus";

/** One line in the live terminal feed (dim, non-fatal). */
function announce(text: string): void {
  publish("terminal", "line", { kind: "note", text });
}

// ── environment ─────────────────────────────────────────────
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
const MAX_ATTEMPTS = envInt("AGENT_LLM_MAX_ATTEMPTS", 3);
const BACKOFF_BASE_MS = envInt("AGENT_LLM_BACKOFF_BASE_MS", 1000);
const BACKOFF_MAX_MS = envInt("AGENT_LLM_BACKOFF_MAX_MS", 30_000);
const BREAKER_AFTER = envInt("AGENT_LLM_BREAKER_AFTER", 3);
const BREAKER_MS = envInt("AGENT_LLM_BREAKER_MS", 90_000);
/** A Retry-After longer than this trips failover instead of waiting. */
const RETRY_AFTER_GIVE_UP_MS = 45_000;

// ── state (globalThis so Next.js HMR keeps one instance) ────
interface ProviderCell {
  /** FIFO queue of waiters for the single in-flight slot. */
  queue: Array<() => void>;
  inflight: number;
  /** Circuit breaker. */
  breakerOpenedAt: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Telemetry for the UI. */
  totalRetries: number;
  totalRequests: number;
}
interface ResilienceState {
  cells: Map<string, ProviderCell>;
}
const STATE_KEY = "__agentLlmResilience";
const g = globalThis as unknown as Record<string, unknown>;
function cells(): Map<string, ProviderCell> {
  let s = g[STATE_KEY] as ResilienceState | undefined;
  if (!s) {
    s = { cells: new Map() };
    g[STATE_KEY] = s;
  }
  return s.cells;
}
function cell(provider: string): ProviderCell {
  let c = cells().get(provider);
  if (!c) {
    c = {
      queue: [],
      inflight: 0,
      breakerOpenedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      totalRetries: 0,
      totalRequests: 0,
    };
    cells().set(provider, c);
  }
  return c;
}

// ── error classification ────────────────────────────────────

/** Thrown when the provider's circuit breaker is OPEN — the auto
 *  chain catches it and skips to the next provider instantly. */
export class LlmCircuitOpenError extends Error {
  constructor(
    public provider: string,
    message: string
  ) {
    super(message);
    this.name = "LlmCircuitOpenError";
  }
}

/** Transient by default: retried with backoff, then failover. */
export function isTransientError(e: unknown): boolean {
  if (e instanceof LlmCircuitOpenError) return false;
  if (asUnavailable(e)) return true;
  const msg = (e as Error).message ?? "";
  return /HTTP (429|5\d\d):|network:|stream:|stream-error:|timeout|aborted|temporarily|overloaded/i.test(msg);
}

/** Minimal structural check so this module has no import cycle
 *  with llm.ts (which imports the queue below). */
interface ProviderUnavailableLike {
  provider: string;
  retryAfterMs?: number;
}
function asUnavailable(e: unknown): ProviderUnavailableLike | null {
  if (e && typeof e === "object" && "provider" in (e as Record<string, unknown>) && "name" in (e as Record<string, unknown>)) {
    const cand = e as Record<string, unknown>;
    if (typeof cand.provider === "string" && /unavailable/i.test(String(cand.name))) {
      return { provider: cand.provider, retryAfterMs: typeof cand.retryAfterMs === "number" ? cand.retryAfterMs : undefined };
    }
  }
  return null;
}

// ── Retry-After parsing (seconds float | HTTP-date) ──────────
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  const asSec = Number(trimmed);
  if (Number.isFinite(asSec) && asSec >= 0) return Math.min(asSec * 1000, RETRY_AFTER_GIVE_UP_MS * 2);
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  // Groq-style body text: "Please try again in 7.017s"
  return undefined;
}

// ── exponential backoff with full jitter (tenacity semantics) ─
export function backoffDelayMs(attempt: number /* 1-based */, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    if (retryAfterMs > RETRY_AFTER_GIVE_UP_MS) return -1; // signal: give up on this provider
    return Math.max(retryAfterMs, 250);
  }
  const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS);
  // full jitter ∈ [exp/2, exp] — avoids synchronized retry storms
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

// ── circuit breaker ──────────────────────────────────────────
export function breakerTripped(provider: string): { open: boolean; remainingMs: number } {
  const c = cell(provider);
  if (c.breakerOpenedAt === null) return { open: false, remainingMs: 0 };
  const elapsed = Date.now() - c.breakerOpenedAt;
  if (elapsed >= BREAKER_MS) {
    // half-open: let the next attempt probe
    c.breakerOpenedAt = null;
    c.consecutiveFailures = Math.max(0, BREAKER_AFTER - 1); // one more failure re-opens
    return { open: false, remainingMs: 0 };
  }
  return { open: true, remainingMs: BREAKER_MS - elapsed };
}
function breakerRecordFailure(provider: string, message: string): void {
  const c = cell(provider);
  c.consecutiveFailures += 1;
  c.lastError = message.slice(0, 200);
  c.lastErrorAt = Date.now();
  if (c.breakerOpenedAt === null && c.consecutiveFailures >= BREAKER_AFTER) {
    c.breakerOpenedAt = Date.now();
    announce(`⚠ ${provider}: circuit OPEN for ${Math.round(BREAKER_MS / 1000)}s after ${c.consecutiveFailures} consecutive failures — the chain will skip it until it recovers.`);
  }
}
function breakerRecordSuccess(provider: string): void {
  const c = cell(provider);
  c.consecutiveFailures = 0;
  c.breakerOpenedAt = null;
  c.lastError = null;
  c.lastErrorAt = null;
}

// ── per-provider serial queue (fair FIFO, 1 slot) ────────────
async function acquireSlot(provider: string): Promise<void> {
  const c = cell(provider);
  c.totalRequests += 1;
  if (c.inflight === 0) {
    c.inflight = 1;
    return;
  }
  const depth = c.queue.length;
  await new Promise<void>((resolve) => {
    c.queue.push(resolve);
  });
  if (depth >= 1) {
    announce(`⏳ ${provider}: request queued (depth ${depth}) — one LLM call at a time per provider.`);
  }
  c.inflight = 1;
}
function releaseSlot(provider: string): void {
  const c = cell(provider);
  const next = c.queue.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter
  } else {
    c.inflight = 0;
  }
}

// ── the public wrapper: queue + backoff + breaker ────────────
export interface RetryNotice {
  provider: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}
/**
 * Run one provider request with FULL resilience:
 *   queue slot → up to MAX_ATTEMPTS attempts → exponential-jitter
 *   backoff honoring Retry-After → breaker bookkeeping.
 * `onRetry` fires BEFORE each wait (the coding runner forwards it to
 * the UI as a live "↺ retrying" line and resets partial deltas).
 */
export async function withLlmResilience<T>(
  provider: string,
  fn: () => Promise<T>,
  opts?: { onRetry?: (notice: RetryNotice) => void | Promise<void> }
): Promise<T> {
  const breaker = breakerTripped(provider);
  if (breaker.open) {
    throw new LlmCircuitOpenError(
      provider,
      `${provider}: circuit breaker OPEN (${Math.ceil(breaker.remainingMs / 1000)}s left) — skipping after repeated failures`
    );
  }

  await acquireSlot(provider);
  try {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const out = await fn();
        breakerRecordSuccess(provider);
        return out;
      } catch (e) {
        lastError = e;
        // Hard protocol errors (bad key 401/403, malformed request 400)
        // are NOT retried — they fail over immediately.
        if (!isTransientError(e)) {
          breakerRecordFailure(provider, (e as Error).message ?? String(e));
          throw e;
        }
        const retryAfter = asUnavailable(e)?.retryAfterMs;
        const delay = backoffDelayMs(attempt, retryAfter);
        if (delay < 0 || attempt === MAX_ATTEMPTS) {
          breakerRecordFailure(provider, (e as Error).message ?? String(e));
          throw e; // provider is exhausted → the auto chain takes over
        }
        cell(provider).totalRetries += 1;
        const reason = (e as Error).message?.slice(0, 140) ?? "transient error";
        const notice: RetryNotice = { provider, attempt, maxAttempts: MAX_ATTEMPTS, delayMs: delay, reason };
        announce(`↺ ${provider} attempt ${attempt}/${MAX_ATTEMPTS} failed (${reason}) — retrying in ${(delay / 1000).toFixed(1)}s`);
        await opts?.onRetry?.(notice);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError; // unreachable, for TS
  } finally {
    releaseSlot(provider);
  }
}

// ── live status for /api/agent/health + the UI queue badge ───
export interface LlmResilienceStatus {
  [provider: string]: {
    inflight: number;
    queued: number;
    breaker: "closed" | "open";
    breakerRemainingMs: number;
    consecutiveFailures: number;
    lastError: string | null;
    totalRetries: number;
  };
}
export function llmResilienceStatus(): LlmResilienceStatus {
  const out: LlmResilienceStatus = {};
  for (const [name, c] of cells()) {
    const breaker = breakerTripped(name);
    out[name] = {
      inflight: c.inflight,
      queued: c.queue.length,
      breaker: breaker.open ? "open" : "closed",
      breakerRemainingMs: breaker.remainingMs,
      consecutiveFailures: c.consecutiveFailures,
      lastError: c.lastError,
      totalRetries: c.totalRetries,
    };
  }
  return out;
}
