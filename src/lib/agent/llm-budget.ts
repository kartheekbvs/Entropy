// ─────────────────────────────────────────────────────────────
// v4.2 BUDGET-AWARE AUTO-TAKEOVER — the "fallback server".
//
// The user's rule: "create a fallback mechanism server like MCP
// which automatically takes [over] after 400 and at finally the
// task will be completed." Every provider gets a DAILY REQUEST
// BUDGET (default 400/day, env-tunable). When a provider's counter
// crosses its budget the chain SKIPS it instantly — exactly like a
// circuit breaker — and the next provider takes over automatically,
// with the full conversation memory preserved, so the task ALWAYS
// completes. Counters reset at UTC midnight (the same moment
// OpenRouter/Groq reset their own daily free-tier windows).
//
// FREE-MODEL chain note: OpenRouter's :free models are capped at
// 50 requests/day per model when the account has < $10 credits —
// each free model gets its own counter with that real-world limit
// (env AGENT_FREECHAIN_DAILY_BUDGET), so the relay rotates
// poolside → nemotron-lightning → dots3 automatically when a free
// model is exhausted for the day.
//
// The budget state is persisted to
//   <workspace>/.agent-state/llm-budget.json
// (debounced write-behind) so the daily cap survives server
// restarts. Status is exposed by /api/agent/health (llmBudget) and
// the MCP tool `agent_budget` — that is the "server" surface, the
// same way agent_health exposes provider preflight.
//
// Env knobs:
//   AGENT_PROVIDER_DAILY_BUDGET   default limit for providers (400)
//   AGENT_FREECHAIN_DAILY_BUDGET  per FREE model limit (50)
//   AGENT_<PROVIDER>_DAILY_BUDGET per-provider override (0 = ∞)
//   e.g. AGENT_GROQ_DAILY_BUDGET=1000
// ─────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";

// Same lazy env access discipline as llm.ts (never at module load).
const env = (name: string): string => process.env[name] || "";

const workspaceRoot = () =>
  path.resolve(
    env("AGENT_WORKSPACE").trim()
      ? env("AGENT_WORKSPACE").trim()
      : path.join(process.env.ENTROPY_PROJECT_ROOT?.trim() || process.cwd(), "workspace")
  );
const STATE_FILE = () => path.join(workspaceRoot(), ".agent-state", "llm-budget.json");

// ── defaults ─────────────────────────────────────────────────
const DEFAULT_PROVIDER_LIMIT = 400; // the user's "after 400" number
const DEFAULT_FREE_MODEL_LIMIT = 50; // OpenRouter :free tier (no credits)

function envInt(name: string): number | undefined {
  const raw = env(name).trim();
  if (!raw) return undefined; // unset OR empty string → default (never 0-by-accident)
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Daily request limit for one budget key (provider or provider:model). */
export function budgetLimitFor(key: string): number {
  const perKey = envInt(`AGENT_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_DAILY_BUDGET`);
  if (perKey !== undefined) return perKey; // 0 = unlimited
  if (key.startsWith("freechain")) return envInt("AGENT_FREECHAIN_DAILY_BUDGET") ?? DEFAULT_FREE_MODEL_LIMIT;
  // v4.3 — Experiential Labs -free slugs (minimax-m2.7-free, …) are
  // zero-cost tier models; protect them with the same small limit.
  if (key.startsWith("explabs:") && /-free\b/.test(key)) return envInt("AGENT_FREECHAIN_DAILY_BUDGET") ?? DEFAULT_FREE_MODEL_LIMIT;
  return envInt("AGENT_PROVIDER_DAILY_BUDGET") ?? DEFAULT_PROVIDER_LIMIT;
}

// ── state (globalThis for HMR + disk persistence) ────────────
interface BudgetState {
  version: 1;
  /** "YYYY-MM-DD" (UTC) → budgetKey → count */
  days: Record<string, Record<string, number>>;
}
const STATE_KEY = "__agentLlmBudget";
const g = globalThis as unknown as Record<string, unknown>;

interface BudgetCell {
  state: BudgetState;
  loaded: boolean;
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
}
function cell(): BudgetCell {
  let c = g[STATE_KEY] as BudgetCell | undefined;
  if (!c) {
    c = { state: { version: 1, days: {} }, loaded: false, dirty: false, flushTimer: null };
    g[STATE_KEY] = c;
  }
  return c;
}

async function loadFromDisk(): Promise<void> {
  const c = cell();
  if (c.loaded) return;
  c.loaded = true;
  try {
    const raw = await fs.readFile(STATE_FILE(), "utf8");
    const parsed = JSON.parse(raw) as BudgetState;
    if (parsed && parsed.version === 1 && parsed.days && typeof parsed.days === "object") {
      c.state.days = parsed.days;
    }
  } catch {
    /* first boot / no file yet — start clean */
  }
}

function scheduleFlush(): void {
  const c = cell();
  c.dirty = true;
  if (c.flushTimer) return;
  c.flushTimer = setTimeout(() => {
    c.flushTimer = null;
    if (!c.dirty) return;
    c.dirty = false;
    void (async () => {
      try {
        await fs.mkdir(path.dirname(STATE_FILE()), { recursive: true });
        await fs.writeFile(STATE_FILE(), JSON.stringify(c.state), "utf8");
      } catch {
        /* best effort — budget still enforced in-memory */
      }
    })();
  }, 1500);
  // keep the Node process free to exit in tests
  if (typeof c.flushTimer.unref === "function") c.flushTimer.unref();
}

// ── day keys (UTC — resets when OpenRouter/Groq reset) ───────
export function dayKeyNow(): string {
  return new Date().toISOString().slice(0, 10);
}
function msUntilUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next - now.getTime());
}

// ── public API ───────────────────────────────────────────────

/** Count one request against a budget key (called on every real
 *  provider attempt — failed attempts consume quota on the real
 *  providers' rate limiters too). */
export function recordBudgetRequest(key: string): void {
  void loadFromDisk(); // fire-and-forget first-touch load
  const c = cell();
  const day = dayKeyNow();
  const today = (c.state.days[day] ??= {});
  today[key] = (today[key] ?? 0) + 1;
  scheduleFlush();
}

export interface BudgetInfo {
  key: string;
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
  /** ms until the counter resets (UTC midnight). */
  resetsInMs: number;
}

export async function budgetInfo(key: string): Promise<BudgetInfo> {
  await loadFromDisk();
  const used = cell().state.days[dayKeyNow()]?.[key] ?? 0;
  const limit = budgetLimitFor(key);
  return {
    key,
    used,
    limit,
    remaining: limit === 0 ? Infinity : Math.max(0, limit - used),
    exhausted: limit !== 0 && used >= limit,
    resetsInMs: msUntilUtcMidnight(),
  };
}

/** Synchronous variant for the hot path (state is loaded by then). */
export function budgetInfoSync(key: string): BudgetInfo {
  const used = cell().state.days[dayKeyNow()]?.[key] ?? 0;
  const limit = budgetLimitFor(key);
  return {
    key,
    used,
    limit,
    remaining: limit === 0 ? Infinity : Math.max(0, limit - used),
    exhausted: limit !== 0 && used >= limit,
    resetsInMs: msUntilUtcMidnight(),
  };
}

/** Status of every tracked key — /api/agent/health + MCP agent_budget. */
export async function budgetStatusAll(): Promise<Record<string, BudgetInfo>> {
  await loadFromDisk();
  const out: Record<string, BudgetInfo> = {};
  const today = cell().state.days[dayKeyNow()] ?? {};
  for (const key of Object.keys(today)) out[key] = budgetInfoSync(key);
  return out;
}

/** Reset all counters (MCP agent_budget tool / tests). */
export function resetBudgets(): void {
  const c = cell();
  c.state.days = {};
  c.dirty = true;
  scheduleFlush();
}

/** Force-write pending state now (used by tests before reading disk). */
export async function flushBudgetState(): Promise<void> {
  const c = cell();
  if (c.flushTimer) {
    clearTimeout(c.flushTimer);
    c.flushTimer = null;
  }
  if (!c.dirty) return;
  c.dirty = false;
  try {
    await fs.mkdir(path.dirname(STATE_FILE()), { recursive: true });
    await fs.writeFile(STATE_FILE(), JSON.stringify(c.state), "utf8");
  } catch {
    /* ignore */
  }
}
