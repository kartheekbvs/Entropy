// ─────────────────────────────────────────────────────────────
// Autonomous CODING agent runner — the Claude-Code-style build
// loop. Same architecture as runner.ts (job agent) but drives the
// sandboxed coding tools: the agent plans, creates folders, writes
// files, runs commands, starts servers, verifies with curl, and
// iterates on errors until the app WORKS.
//
// Transcript persists to the AgentRun table (mode = "coding") so
// the console UI polls it live, exactly like the job agent.
//
// v3.7 "IRON MAN" reliability layer (OpenClaude QueryEngine-inspired):
//   • CHAIN PATIENCE — when EVERY provider is down the run does not
//     die: it holds (30s / 60s / 120s) and retries the chain while
//     the time budget lasts, memory intact.
//   • HANDOFF EVENTS — a provider dying mid-run visibly hands its
//     memory to the next provider in the transcript.
//   • CHECKPOINT + RESUME — the full conversation is checkpointed
//     to disk after every round; a crashed / killed / stale run can
//     be RESUMED and continues coding with its memory restored.
//   • AUTO-COMPACT — deterministic history compaction when the
//     conversation grows past a threshold (marathon-context safety).
//   • ROUND STATS — every round logs provider · seconds · tokens so
//     liveness is always visible (no more "what is happening?").
// ─────────────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { CODING_TOOLS, WORKSPACE_ROOT, getShellInfo, READ_ONLY_TOOLS, PARALLEL_TOOL_LIMIT } from "./coding-tools";
import {
  generateWithAuto,
  compactToolResult,
  assertProviderConfigured,
  diagnoseRunError,
  NoLlmProviderError,
  type HistoryTurn,
  type AgentToolCall,
  type GenerateOpts,
  type LlmUsage,
} from "./llm";
import { loadExternalMcpTools } from "./mcp-client";
import { publishDelta, publishReasoning, publishUsage, terminalLine, publish } from "./event-bus";
import type { ToolDef } from "./tools";
import { rateLimit, rateLimitStatus, RateLimitError } from "./rate-limit";
import { promises as fs } from "node:fs";
import path from "node:path";

// ── v4.2 CONVERSATION SNAPSHOT — chat-continue memory ────────
// Completed runs keep their FULL conversation on disk (the v3.7
// checkpoint is retired on completion, but Copilot-Chat-style
// follow-up turns — “after some execution we can chat to continue
// the project for changes” — need that memory). continueCodingRun()
// loads this snapshot, appends the user's follow-up and re-enters
// the loop with the project's full context restored.
interface ConversationSnapshot {
  version: 1;
  runId: string;
  goal: string;
  history: HistoryTurn[];
  writtenPaths: string[];
  tokens: number;
  providerUsed: string;
  rounds: number;
  savedAt: number;
}
const CONVERSATION_FILE = () => path.join(WORKSPACE_ROOT, ".agent-state", "conversation.json");

async function saveConversationSnapshot(snap: Omit<ConversationSnapshot, "version" | "savedAt">): Promise<void> {
  try {
    await fs.mkdir(path.dirname(CONVERSATION_FILE()), { recursive: true });
    const full: ConversationSnapshot = { version: 1, savedAt: Date.now(), ...snap };
    await fs.writeFile(CONVERSATION_FILE(), JSON.stringify(full), "utf8");
  } catch (e) {
    console.warn(`[coding-agent] conversation snapshot save failed: ${(e as Error).message}`);
  }
}

async function loadConversationSnapshot(): Promise<ConversationSnapshot | null> {
  try {
    const raw = await fs.readFile(CONVERSATION_FILE(), "utf8");
    const snap = JSON.parse(raw) as ConversationSnapshot;
    return snap && snap.version === 1 && Array.isArray(snap.history) ? snap : null;
  } catch {
    return null;
  }
}

/** v4.2 — is there a chat-continuable project on disk? (UI hint) */
export async function hasConversationSnapshot(): Promise<boolean> {
  return (await loadConversationSnapshot()) !== null;
}

export interface CodingStep {
  i: number;
  ts: number;
  type: "goal" | "assistant" | "tool_call" | "tool_result" | "note" | "final" | "error";
  text?: string;
  name?: string;
  args?: unknown;
  summary?: string;
  preview?: string;
}

// ── v4.0 TURBO — parallel tool partitioning (openclaude’s
// partitionToolCalls pattern). A model turn may emit several tool
// calls: CONSECUTIVE read-only calls (fs_list, fs_read, fs_tree,
// todo_read …) form one PARALLEL group — they cannot interfere with
// each other, so they run concurrently and their latency stacks
// instead of adding up. Mutating calls (fs_batch, fs_write, shell_run,
// MCP …) always run alone and in order. Result order always matches
// the model’s original call order so replay stays valid.
export function partitionToolCalls(calls: AgentToolCall[]): AgentToolCall[][] {
  const groups: AgentToolCall[][] = [];
  let batch: AgentToolCall[] = [];
  const flush = () => {
    if (batch.length > 0) {
      groups.push(batch);
      batch = [];
    }
  };
  for (const call of calls) {
    if (READ_ONLY_TOOLS.has(call.name)) {
      batch.push(call);
      if (batch.length >= PARALLEL_TOOL_LIMIT) flush();
    } else {
      flush();
      groups.push([call]);
    }
  }
  flush();
  return groups;
}

// v4.0 usage note — appended to every round stat so the console and
// the xterm terminal show WHERE the tokens went (in/out/cached/ttft/tok-s).
function formatUsageNote(u: LlmUsage | undefined): string {
  if (!u) return "";
  const parts: string[] = [];
  if (u.promptTokens !== undefined || u.completionTokens !== undefined) {
    parts.push(`in ${((u.promptTokens ?? 0) / 1000).toFixed(1)}k / out ${((u.completionTokens ?? 0) / 1000).toFixed(1)}k`);
  }
  if (u.cachedTokens) parts.push(`cached ${(u.cachedTokens / 1000).toFixed(1)}k`);
  if (u.reasoningTokens) parts.push(`${u.reasoningTokens} think`);
  if (u.tokPerSec !== undefined) parts.push(`${u.tokPerSec} tok/s`);
  if (u.ttftMs !== undefined && u.ttftMs > 0) parts.push(`ttft ${Math.round(u.ttftMs)}ms`);
  if (u.costUsd !== undefined) parts.push(`$${u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(3)}`);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

// One-line description of a tool call for the xterm feed (args → compact json).
function toolCallLine(call: AgentToolCall): string {
  let argsPreview = "";
  try {
    argsPreview = JSON.stringify(call.args ?? {});
  } catch {
    argsPreview = "…";
  }
  if (argsPreview.length > 160) argsPreview = `${argsPreview.slice(0, 157)}…`;
  return `${call.name} ${argsPreview}`;
}

// ── v3.7 DISK CHECKPOINTS (resume memory) ───────────────────
// One JSON per run under workspace/.agent-state/ holding the FULL
// conversation + progress, saved after every round. If the process
// dies (laptop sleep, crash, kill), resumeCodingAgentRun() rebuilds
// the run from this file and the next model CONTINUES where the
// dead one stopped — workspace files are already safe on disk.
interface RunCheckpoint {
  version: 1;
  runId: string;
  goal: string;
  history: HistoryTurn[];
  writtenPaths: string[];
  rounds: number;
  tokens: number;
  providerUsed: string;
  savedAt: number;
}

const STATE_DIR = path.join(WORKSPACE_ROOT, ".agent-state");
const checkpointPath = (runId: string) => path.join(STATE_DIR, `${runId}.json`);

async function saveCheckpoint(cp: RunCheckpoint): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(checkpointPath(cp.runId), JSON.stringify(cp), "utf8");
  } catch (e) {
    console.warn(`[coding-agent] checkpoint save failed: ${(e as Error).message}`);
  }
}

async function loadCheckpoint(runId: string): Promise<RunCheckpoint | null> {
  try {
    const raw = await fs.readFile(checkpointPath(runId), "utf8");
    const cp = JSON.parse(raw) as RunCheckpoint;
    return cp && cp.version === 1 && Array.isArray(cp.history) ? cp : null;
  } catch {
    return null;
  }
}

async function clearCheckpoint(runId: string): Promise<void> {
  try {
    await fs.rm(checkpointPath(runId), { force: true });
  } catch {
    /* best effort */
  }
}

// ── v3.7 DETERMINISTIC AUTO-COMPACT (marathon context safety) ──
// OpenClaude's QueryEngine auto-compacts near the context limit via
// an LLM summary; we do it DETERMINISTICALLY (no model dependency,
// cannot fail): once the serialized history passes the soft cap,
// tool-result payloads older than the last keepTurns are replaced
// by one-line digests. The plan, code and recent context stay full.
const HISTORY_SOFT_MAX_CHARS = (() => {
  const v = Number(process.env["AGENT_HISTORY_MAX_CHARS"]);
  return Number.isFinite(v) && v > 20_000 ? Math.floor(v) : 280_000;
})();

const jsonLen = (h: HistoryTurn[]): number => {
  try {
    return JSON.stringify(h).length;
  } catch {
    return 0;
  }
};

function compactHistoryDigest(history: HistoryTurn[], keepTurns = 14): HistoryTurn[] {
  const cut = Math.max(0, history.length - keepTurns);
  if (cut === 0) return history;
  const head = history.slice(0, cut).map((turn) => {
    if (turn.role !== "toolResults" || !Array.isArray(turn.results)) return turn;
    const names = turn.results.map((r) => r.name).join(", ");
    return {
      ...turn,
      results: [
        {
          name: turn.results[0]?.name ?? "tools",
          result: {
            digest: `${turn.results.length} earlier tool results compacted to save context (${names.slice(0, 200)}). The files/changes they made persist on disk.`,
          },
        },
      ],
    };
  });
  return [...head, ...history.slice(cut)];
}

// v3.5 MARATHON LIMITS — the user asked for a MASSIVE long-task agent:
// 150 LLM rounds (was 80) and a 90-minute budget (was 45). Both
// env-tunable without code changes:
//   AGENT_MAX_ROUNDS=200   AGENT_BUDGET_MINUTES=120
const roundLimit = () => {
  const v = Number(process.env["AGENT_MAX_ROUNDS"]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 150;
};
const MAX_TOOL_ROUNDS = roundLimit();
const budgetMinutes = () => {
  const v = Number(process.env["AGENT_BUDGET_MINUTES"]);
  return Number.isFinite(v) && v > 0 ? v : 90;
};
const OVERALL_BUDGET_MS = budgetMinutes() * 60 * 1000;

// ── Busy lock (shared with the job agent: one agent at a time) ─
const g = globalThis as unknown as {
  __agentBusyRunId?: string | null;
  __agentStopRequested?: boolean;
};

export function isCodingAgentBusy(): boolean {
  return Boolean(g.__agentBusyRunId);
}

export function requestCodingStop(): boolean {
  if (!g.__agentBusyRunId) return false;
  g.__agentStopRequested = true;
  return true;
}

// ── System prompt — Claude Code engineering discipline ───────
async function buildCodingSystemPrompt(
  externalTools: ToolDef[] = []
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const shell = await getShellInfo();
  const platformLine =
    shell.kind === "cmd"
      ? `You are on WINDOWS with cmd.exe (no bash). Prefer simple, single-purpose commands: node server.js, npm install, python app.py, dir, type, copy, curl. Avoid bash-only syntax (subshells, $(), 2>/dev/null, word splitting tricks). Node/npm/python/git all work normally.`
      : `You are on a unix-like system with bash. Standard bash syntax is fine.`;
  const mcpLine =
    externalTools.length > 0
      ? `\n\nEXTERNAL MCP TOOLS (${externalTools.length}): ${externalTools
          .slice(0, 30)
          .map((t) => t.name)
          .join(", ")}${
          externalTools.length > 30 ? ", …" : ""
        } — REAL remote capabilities served by external MCP servers (e.g. the official github-mcp-server: repos, issues, pull requests). Call them like any other tool; they hit live remote APIs, so explore read-only first and be deliberate before mutating anything.`
      : "";
  return `You are KARTHEEK'S AUTONOMOUS CODING AGENT — a senior software engineer that BUILDS AND RUNS real applications, working like Claude Code. Today is ${date}.

You have ${CODING_TOOLS.length + externalTools.length} real tools: the ${CODING_TOOLS.length} built-in ones (${CODING_TOOLS.map((t) => t.name).join(", ")}) plus the external MCP tools listed below.${mcpLine}

${platformLine}

TURBO RULES (v4.0 — rounds are your scarcest resource; every saved round is seconds of latency AND tokens):
- BATCH OPERATIONS: create ALL folders and write MULTIPLE files in ONE fs_batch call. A scaffold like app/, app/templates/, app/static/css/ plus their first files is ONE fs_batch — never one fs_mkdir per round.
- MULTI-CALL TURNS: when a turn needs several independent READS (fs_list, fs_read, fs_tree, todo_read), emit them ALL in the same turn — read-only calls execute in parallel automatically.
- COMPLETE FILES: write each file fully in a single op (fs_write or a fs_batch write op); large files may span 2-3 ops, but never leave placeholders.
- README-FIRST (v4.2): EVERY project scaffold MUST include README.md in the FIRST fs_batch — WHAT IT IS, PREREQUISITES, INSTALL, RUN and TEST commands, PORT/URL. The runner double-checks on disk at completion and generates one deterministically if you forget, but write a proper one yourself — it is the first file a user opens.

ENGINEERING PRINCIPLES (Claude Code discipline):
0. MARATHON BUDGET: you have up to ${MAX_TOOL_ROUNDS} tool rounds and ${Math.round(OVERALL_BUDGET_MS / 60000)} minutes — take the time to plan, build, RUN, and VERIFY properly. Do not rush a half-finished app just to answer early; also do not idle on redundant steps.
1. PLAN FIRST: for any non-trivial build, call todo_write with 3-8 steps BEFORE writing code, and keep statuses updated as you go. Decide the file tree before writing (fs_tree/fs_list to inspect what exists).
2. COMPLETE APPLICATIONS: production-quality code. HTML pages link their CSS/JS. Node servers bind 0.0.0.0 with an explicit port. Python tools are runnable. Include package.json when deps are needed. Never placeholders, never "// TODO".
3. EDIT SURGICALLY: to modify an existing file use fs_edit (exact search/replace) — NOT fs_write of the whole file. Read before editing; include context lines so the match is unique.
4. RUN AND VERIFY: after building, actually RUN it — start servers in the background (end command with "&"), then curl the URL and check the response. Run tests/scripts and read their output. If it fails, fs_read the bg log, fs_edit the fix, re-verify. Do not claim success without verification evidence.
5. ITERATE: errors are normal — fix them with minimal, targeted edits.
6. CLEAN PORTS: use ports 4500-4999 unless the goal specifies otherwise. Kill your own background processes (kill <pid>, or taskkill /pid <pid> /T /F on Windows) when they're only needed for verification.
7. Be autonomous: never ask questions mid-run; make reasonable decisions and report them.
8. SECURITY: everything stays inside the workspace sandbox; relative paths only.
9. MEMORY: a file workspace/AGENT.md may exist with project memories/preferences — honor it, and (when the goal warrants it) append useful notes for future runs via fs_edit/fs_write.

FINAL ANSWER (when done) — concise markdown, under 400 words:
1. WHAT WAS BUILT — app summary + file tree
2. HOW TO RUN IT — exact commands (from workspace root) + port/URL
3. VERIFICATION — the real command + output excerpt that proves it works
4. NOTES — anything to know next (extensions, ideas)`;
}

// ── AGENT.md — persistent project memory (CLAUDE.md parity) ──
async function readAgentMemory(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(WORKSPACE_ROOT, "AGENT.md"), "utf8");
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 4000) : null;
  } catch {
    return null;
  }
}

// ── Transcript ────────────────────────────────────────────────
class CodingTranscript {
  steps: CodingStep[] = [];
  constructor(private runId: string) {}
  push(step: Omit<CodingStep, "i" | "ts">) {
    this.steps.push({ ...step, i: this.steps.length + 1, ts: Date.now() });
  }
  async flush(extra: Record<string, unknown> = {}) {
    try {
      await db.agentRun.update({
        where: { id: this.runId },
        data: { steps: JSON.stringify(this.steps), stepCount: this.steps.length, ...extra },
      });
    } catch {
      /* best-effort persistence */
    }
  }
}

function summarizeCodingResult(result: unknown): { summary: string; preview: string } {
  let json = "";
  try {
    json = JSON.stringify(result);
  } catch {
    json = String(result);
  }
  const preview = json.slice(0, 1200);
  let summary = `${json.length} chars`;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (r.background) {
      summary = `bg pid ${r.pid} · log ${r.logFile}`;
    } else if (typeof r.exitCode === "number") {
      summary = `exit ${r.exitCode}${r.timedOut ? " (timeout)" : ""} · ${r.durationMs}ms`;
    } else if (typeof r.content === "string") {
      summary = `read ${r.bytes} bytes${r.truncated ? " (truncated)" : ""}`;
    } else if (typeof r.bytes === "number") {
      summary = `wrote ${r.bytes} bytes${r.created ? " (new)" : ""}`;
    } else if (Array.isArray(r.entries)) {
      summary = `${r.count} entries`;
    } else if (Array.isArray(r.results)) {
      summary = `${r.matches} matches`;
    } else if (Array.isArray(r.files)) {
      summary = `${r.matches} files match`;
    } else if (typeof r.tree === "string") {
      summary = `tree · ${r.entries} entries`;
    } else if (Array.isArray(r.todos)) {
      summary = `plan: ${r.summary ?? `${r.todos.length} items`}`;
    } else if (typeof r.occurrences === "number") {
      summary = `edited ${r.occurrences}× · ${r.bytesBefore}→${r.bytesAfter}B`;
    } else if (r.copied) {
      summary = `copied ${r.from} → ${r.to}`;
    } else if (r.moved) {
      summary = `moved ${r.from} → ${r.to}`;
    } else if (typeof r.deleted === "boolean") {
      summary = "deleted";
    } else if (typeof r.created === "boolean") {
      summary = r.path && String(r.path).includes("/") ? "folder created" : "created";
    } else if (r.workspaceRoot) {
      const sys = r.system as Record<string, unknown> | undefined;
      const sh = r.shell as { kind?: string } | undefined;
      summary = `workspace ${r.files} files · ${sys?.cpuCores ?? "?"} cores · ${sys?.freeMemoryMB ?? "?"}MB free · shell ${sh?.kind ?? "?"}`;
    } else if (r.error) {
      summary = `error: ${String(r.error).slice(0, 80)}`;
    }
  }
  return { summary, preview };
}

// ── Public API ────────────────────────────────────────────────

/** Fire-and-forget start (UI): returns the run id immediately. */
export async function startCodingAgentRun(goal: string, mode: "manual" | "autopilot" = "manual"): Promise<string> {
  const run = await db.agentRun.create({
    data: { goal, mode: "coding", status: "running", steps: "[]" },
  });
  g.__agentBusyRunId = run.id;
  g.__agentStopRequested = false;
  void runCodingAgent(run.id, goal).catch(async (e) => {
    console.error(`coding run ${run.id} crashed:`, e);
    g.__agentBusyRunId = null;
    try {
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: "failed", result: `Coding runner crashed: ${(e as Error).message}`, finishedAt: new Date() },
      });
    } catch {
      /* ignore */
    }
  });
  return run.id;
}

/** Awaited variant used by the MCP server (returns the completed run). */
export async function runCodingAgentToCompletion(goal: string): Promise<{
  id: string;
  status: string;
  provider: string;
  result: string;
  stepLog: string[];
}> {
  if (g.__agentBusyRunId) throw new Error("another agent run is active in this process");
  const run = await db.agentRun.create({
    data: { goal, mode: "coding", status: "running", steps: "[]" },
  });
  g.__agentBusyRunId = run.id;
  g.__agentStopRequested = false;
  try {
    await runCodingAgent(run.id, goal);
  } finally {
    if (g.__agentBusyRunId === run.id) g.__agentBusyRunId = null;
    g.__agentStopRequested = false;
  }
  const row = await db.agentRun.findUnique({ where: { id: run.id } });
  const steps: CodingStep[] = row ? JSON.parse(row.steps || "[]") : [];
  return {
    id: run.id,
    status: row?.status ?? "unknown",
    provider: row?.provider ?? "",
    result: row?.result ?? "",
    stepLog: steps
      .filter((s) => s.type === "tool_call" || s.type === "note" || s.type === "error")
      .map((s) => (s.type === "tool_call" ? `${s.i}. tool: ${s.name}` : `${s.i}. ${s.type}: ${(s.text ?? "").slice(0, 100)}`)),
  };
}

// ── v3.7 RESUME — "fallback the memory when a model stops working
// then another model continues it, keeping the project safe and
// continuing to code." Restores a run from its disk checkpoint
// (conversation + progress + written-file ledger) and continues the
// loop with whichever provider is healthy NOW. The old run row is
// marked "resumed" and points at its continuation.
export async function resumeCodingAgentRun(oldRunId: string): Promise<{
  ok: boolean;
  runId?: string;
  message: string;
}> {
  if (g.__agentBusyRunId) {
    return { ok: false, message: "An agent run is already active — wait for it to finish or stop it first." };
  }
  const old = await db.agentRun.findUnique({ where: { id: oldRunId } });
  if (!old || old.mode !== "coding") {
    return { ok: false, message: "Run not found (or not a coding run)." };
  }
  if (old.status === "running") {
    return { ok: false, message: "That run is still running — nothing to resume." };
  }
  const cp = await loadCheckpoint(oldRunId);
  if (!cp) {
    return {
      ok: false,
      message:
        "No disk checkpoint for that run (checkpoints are written from v3.7, after every round; completed runs are cleaned up). Re-run the goal instead — workspace files persist.",
    };
  }

  const run = await db.agentRun.create({
    data: { goal: old.goal, mode: "coding", status: "running", steps: "[]" },
  });
  g.__agentBusyRunId = run.id;
  g.__agentStopRequested = false;
  void runCodingAgent(run.id, old.goal, {
    history: cp.history,
    writtenPaths: new Set(cp.writtenPaths),
    rounds: cp.rounds,
    tokens: cp.tokens,
    providerUsed: cp.providerUsed,
    resumedFrom: { runId: oldRunId, savedAt: cp.savedAt, steps: cp.rounds },
  }).catch(async (e) => {
    console.error(`resumed coding run ${run.id} crashed:`, e);
    g.__agentBusyRunId = null;
    try {
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: "failed", result: `Resumed run crashed: ${(e as Error).message}`, finishedAt: new Date() },
      });
    } catch {
      /* ignore */
    }
  });
  await db.agentRun
    .update({
      where: { id: oldRunId },
      data: { status: old.status === "failed" || old.status === "interrupted" ? "resumed" : old.status },
    })
    .catch(() => undefined);
  return {
    ok: true,
    runId: run.id,
    message: `Resumed run ${oldRunId.slice(0, 8)} with full memory (${cp.history.length} turns, ${cp.rounds} rounds) → new run ${run.id.slice(0, 8)}.`,
  };
}

/** Does a resumable checkpoint exist for this run? (UI hint.) */
export async function hasCheckpoint(runId: string): Promise<boolean> {
  return (await loadCheckpoint(runId)) !== null;
}

// ── v4.2 README.md GUARANTEE (deterministic safety net) ───────
// "for every project prompt the repo should contain how to run the
// projects readme.md by default." The system prompt now demands
// README-FIRST from the model; THIS is the guarantee layer: if no
// README.md exists when a run completes, the runner itself writes
// one from the REAL workspace — detected stack, entry points, port,
// actual file tree. No model dependency, cannot fail, cannot lie.
const README_IGNORE = new Set([".agent-state", ".agent-shell", ".archive", "node_modules", ".git", "__pycache__", "AGENT.md"]);

async function ensureProjectReadme(goal: string): Promise<string | null> {
  try {
    await fs.access(WORKSPACE_ROOT);
  } catch {
    return null; // no workspace at all — nothing to guarantee
  }
  // Where does the project live? If the run produced exactly ONE
  // top-level project dir, the README belongs inside it; otherwise
  // it goes at the workspace root.
  const top = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const visible = top.filter((e) => !README_IGNORE.has(e.name) && !e.name.startsWith("."));
  const dirs = visible.filter((e) => e.isDirectory());
  const files = visible.filter((e) => e.isFile());
  const singleProject = dirs.length === 1 && files.length === 0 ? dirs[0].name : null;
  const root = singleProject ? path.join(WORKSPACE_ROOT, singleProject) : WORKSPACE_ROOT;
  const relRoot = singleProject ? singleProject : ".";
  const readmePath = path.join(root, "README.md");
  try {
    await fs.access(readmePath);
    return null; // already present (model wrote one — README-FIRST honored)
  } catch {
    /* generate it */
  }

  // Detect the stack from real files (best effort, all optional).
  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.access(path.join(root, p));
      return true;
    } catch {
      return false;
    }
  };
  const readJson = async (p: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await fs.readFile(path.join(root, p), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const pkg = (await exists("package.json")) ? await readJson("package.json") : null;
  const hasReq = await exists("requirements.txt");
  const pyEntry = (await exists("main.py")) ? "main.py" : (await exists("app.py")) ? "app.py" : null;
  const hasHtml = await exists("index.html");
  const hasServerJs = await exists("server.js") || (pkg?.main ? typeof pkg.main === "string" : false);
  const portMatch = /port\s*[:=]?\s*(\d{4})/i.exec(goal ?? "");
  const goalPort = portMatch ? portMatch[1] : "";

  // Compact file tree (top 2 levels, capped).
  const treeLines: string[] = [];
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (treeLines.length >= 40) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (treeLines.length >= 40) return;
      if (README_IGNORE.has(e.name) || e.name.startsWith(".")) continue;
      treeLines.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory() && depth < 2) await walk(path.join(dir, e.name), `${prefix}  `, depth + 1);
    }
  };
  await walk(root, "", 1);

  const lines: string[] = [
    `# ${singleProject ?? "Project"} — README`,
    "",
    "> Generated automatically by the Job Command Center coding agent (v4.2 README guarantee — every project ships run instructions by default).",
    "",
    "## What this is",
    (goal || "A project built by the autonomous coding agent.").slice(0, 500),
    "",
    "## Files",
    ...(treeLines.length > 0 ? treeLines.map((l) => `- ${l}`) : ["- (see the workspace)"]),
    "",
    "## How to run",
  ];
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    lines.push("Node.js project:");
    lines.push("```bash");
    lines.push("npm install");
    lines.push(scripts.start ? "npm start" : hasServerJs ? "node server.js" : `node ${typeof pkg.main === "string" ? pkg.main : "index.js"}`);
    lines.push("```");
  } else if (hasServerJs) {
    lines.push("Node.js project (no package.json):");
    lines.push("```bash");
    lines.push("node server.js");
    lines.push("```");
  }
  if (hasReq || pyEntry) {
    lines.push("Python project:");
    lines.push("```bash");
    if (hasReq) lines.push("pip install -r requirements.txt");
    lines.push(`python ${pyEntry ?? "main.py"}`);
    lines.push("```");
  }
  if (hasHtml && !pkg && !hasServerJs && !pyEntry) {
    lines.push("Static site — open `index.html` directly in a browser (no server needed).");
  }
  if (goalPort) lines.push("", `The app listens on port **${goalPort}** → http://localhost:${goalPort}`);
  lines.push(
    "",
    "## Notes",
    "- Built inside the agent's sandboxed workspace; everything is plain files — copy the folder anywhere.",
    "- Ask the agent to continue this project: use the follow-up chat on the Agent tab (“continue this project: …”).",
    "- Full build transcript + verification evidence live in the dashboard's Run History."
  );

  try {
    await fs.writeFile(readmePath, `${lines.join("\n")}\n`, "utf8");
    return `📘 README.md ${relRoot !== "." ? `(${relRoot}/README.md) ` : ""}was missing — generated deterministically from the real workspace (stack detected${goalPort ? `, port ${goalPort}` : ""}, ${treeLines.length} tree entries) so the project always ships run instructions by default.`;
  } catch (e) {
    console.warn(`[coding-agent] README guarantee failed: ${(e as Error).message}`);
    return null;
  }
}

// ── v4.2 CHAT-CONTINUE — Copilot-Chat-style follow-up turns ──
// "after some execution we can chat to continuing the project for
// changes": the completed run's conversation snapshot is restored,
// the user's follow-up is appended as a user turn (with a live
// workspace tree refresh), and the loop re-enters with the SAME
// tools + failover chain. The new run row links back to the source.
export async function continueCodingRun(
  message: string,
  runId?: string
): Promise<{ ok: boolean; runId?: string; message: string }> {
  const trimmed = message.trim();
  if (trimmed.length < 3 || trimmed.length > 2000) {
    return { ok: false, message: "Follow-up message must be 3–2000 characters." };
  }
  if (g.__agentBusyRunId) {
    return { ok: false, message: "An agent run is already active — wait for it to finish or stop it first." };
  }
  const snap = await loadConversationSnapshot();
  if (!snap) {
    return {
      ok: false,
      message:
        "No chat-continuable project yet — complete a coding run first (snapshots are kept from v4.2 completions). Workspace files always persist, so a fresh run can also pick the project up.",
    };
  }
  if (runId && snap.runId !== runId) {
    return {
      ok: false,
      message: `The latest conversation snapshot belongs to run ${snap.runId.slice(0, 8)} (asked for ${runId.slice(0, 8)}). Continuing the latest project instead is safer — send without a runId, or re-run that goal.`,
    };
  }

  const followUpGoal = `${snap.goal.slice(0, 400)}\n\n▸ CONTINUE (follow-up chat): ${trimmed.slice(0, 600)}`;
  const run = await db.agentRun.create({
    data: { goal: followUpGoal, mode: "coding", status: "running", steps: "[]" },
  });
  g.__agentBusyRunId = run.id;
  g.__agentStopRequested = false;
  void runCodingAgent(run.id, followUpGoal, {
    history: snap.history,
    writtenPaths: new Set(snap.writtenPaths),
    rounds: 0, // fresh tool budget for the follow-up
    tokens: 0,
    providerUsed: "",
    resumedFrom: { runId: snap.runId, savedAt: snap.savedAt, steps: snap.rounds },
    followUp: trimmed,
  }).catch(async (e) => {
    console.error(`continued coding run ${run.id} crashed:`, e);
    g.__agentBusyRunId = null;
    try {
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: "failed", result: `Continued run crashed: ${(e as Error).message}`, finishedAt: new Date() },
      });
    } catch {
      /* ignore */
    }
  });
  return {
    ok: true,
    runId: run.id,
    message: `Continuing the project from run ${snap.runId.slice(0, 8)} with full memory (${snap.history.length} turns, ${snap.writtenPaths.length} files tracked) → new run ${run.id.slice(0, 8)}.`,
  };
}

// ── Deterministic post-run verification (v3.5 "accuracy" layer) ─
// The runner ITSELF cross-checks every file the agent wrote against
// the real filesystem and appends the result to the final report —
// the model cannot claim files that do not exist.
const WRITE_TOOLS = new Set(["fs_write", "fs_edit", "fs_copy", "fs_move", "fs_batch"]);

// v4.0: fs_batch writes MANY files in one call — expand its ops so
// the deterministic post-run verification tracks every path.
function trackWrittenPaths(name: string, args: Record<string, unknown>): string[] {
  if (name === "fs_batch" && Array.isArray(args.ops)) {
    return (args.ops as Array<Record<string, unknown>>)
      .filter((o) => String(o.op ?? "") === "write")
      .map((o) => (typeof o.path === "string" ? o.path.trim() : ""))
      .filter((p) => p.length > 0);
  }
  for (const key of ["path", "destination", "dest", "target"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return [v.trim()];
  }
  return [];
}

async function verifyArtifacts(written: Set<string>): Promise<string> {
  if (written.size === 0) return "";
  const lines: string[] = [];
  let ok = 0;
  let missing = 0;
  for (const rel of [...written].slice(0, 30)) {
    try {
      const stat = await fs.stat(path.join(WORKSPACE_ROOT, rel));
      lines.push(`- ${rel} — EXISTS (${stat.size.toLocaleString()} bytes)`);
      ok++;
    } catch {
      lines.push(`- ${rel} — NOT FOUND on disk`);
      missing++;
    }
  }
  if (lines.length === 0) return "";
  return [
    "## VERIFIED ON DISK (deterministic post-run check — generated by the runner, not the model)",
    ...lines,
    `(${ok} verified present, ${missing} missing — the report above is cross-checked against the real filesystem.)`,
  ].join("\n");
}

// ── LLM call with rate-limit backoff + v3.7 CHAIN PATIENCE ──
// The user's rule: "when a model stops working, another model
// continues, keeping the project safe". Per-provider failover is
// handled inside generateWithAuto; CHAIN patience handles the case
// where EVERY provider is unavailable (outage, quota, offline):
// instead of killing the run we HOLD the memory and retry the whole
// chain after 30s / 60s / 120s while the budget lasts.
const CHAIN_WAIT_SCHEDULE_MS = [30_000, 60_000, 120_000];

interface PatienceCtx {
  t: CodingTranscript;
  startedAt: number;
  budgetMs: number;
  busy: () => boolean; // returns false when the runner crashed elsewhere
}

async function generateWithRateLimit(
  history: HistoryTurn[],
  system: string,
  tools: ToolDef[],
  opts?: GenerateOpts
): Promise<Awaited<ReturnType<typeof generateWithAuto>>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const rl = rateLimit("llm", "coding");
    if (rl.allowed) return generateWithAuto(history, tools, system, opts);
    const wait = Math.min(rl.retryAfterMs, 30_000);
    console.warn(`[coding-agent] LLM rate limit — waiting ${Math.round(wait / 1000)}s`);
    opts?.onReset?.();
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new RateLimitError(rateLimit("llm", "coding"));
}

async function generateWithPatience(
  history: HistoryTurn[],
  system: string,
  tools: ToolDef[],
  ctx: PatienceCtx,
  opts?: GenerateOpts
): Promise<Awaited<ReturnType<typeof generateWithAuto>>> {
  let patience = 0;
  for (;;) {
    try {
      return await generateWithRateLimit(history, system, tools, opts);
    } catch (e) {
      if (!(e instanceof NoLlmProviderError)) throw e;
      const waitMs = CHAIN_WAIT_SCHEDULE_MS[patience];
      const elapsed = Date.now() - ctx.startedAt;
      if (waitMs === undefined || elapsed + waitMs + 60_000 > ctx.budgetMs) {
        throw e; // genuinely out of options / out of time
      }
      patience++;
      const noteText = `All LLM providers are unavailable — HOLDING the run and its memory safe, retrying in ${Math.round(waitMs / 1000)}s (patience attempt ${patience}/${CHAIN_WAIT_SCHEDULE_MS.length}). Work already on disk is untouched.`;
      ctx.t.push({ type: "note", text: noteText });
      terminalLine("note", noteText);
      await ctx.t.flush();
      opts?.onReset?.();
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ── Graceful degradation: synthesize an honest report from the
// transcript when the LLM dies late in the run ─────────────────
function synthesizeCodingReport(t: CodingTranscript, goal: string, reason: string): string {
  const toolCalls = t.steps.filter((s) => s.type === "tool_call");
  const results = t.steps.filter((s) => s.type === "tool_result");
  const lines: string[] = [
    "# RUN REPORT (synthesized from transcript)",
    "",
    `The LLM became unavailable before its final summary turn (${reason.slice(0, 160)}).`,
    "This report was generated deterministically from the run transcript so the work is not lost.",
    "",
    "## GOAL",
    goal.slice(0, 400),
    "",
    "## WHAT WAS DONE",
    `${toolCalls.length} tool calls completed:`,
  ];
  for (const s of results.slice(-14)) {
    lines.push(`- **${s.name}** → ${s.summary ?? "ok"}`);
  }
  const shellSteps = results.filter((s) => s.name === "shell_run");
  if (shellSteps.length > 0) {
    lines.push("", "## LAST SHELL OUTPUT");
    const last = shellSteps[shellSteps.length - 1];
    lines.push((last.preview ?? "").slice(0, 600));
  }
  lines.push("", "## NOTE", "Re-run the same goal (or inspect the workspace) to continue — files and any started servers are live.");
  return lines.join("\n");
}

// ── The loop ──────────────────────────────────────────────────
interface RestoredState {
  history: HistoryTurn[];
  writtenPaths: Set<string>;
  rounds: number;
  tokens: number;
  providerUsed: string;
  resumedFrom: { runId: string; savedAt: number; steps: number };
  /** v4.2 — chat-continue: the user's follow-up message (appended as
   *  a user turn with a live workspace-tree refresh). */
  followUp?: string;
}

async function runCodingAgent(runId: string, goal: string, restored?: RestoredState): Promise<void> {
  const t = new CodingTranscript(runId);
  let history: HistoryTurn[] = restored?.history ?? [];
  let tokens = restored?.tokens ?? 0;
  let providerUsed = restored?.providerUsed ?? "";
  const startedAt = Date.now();
  const writtenPaths = restored?.writtenPaths ?? new Set<string>();
  let mcpCleanup: (() => void) | null = null;
  let effectiveRounds = restored?.rounds ?? 0; // v3.7: marathon progress carries over across resumes

  try {
    t.push({ type: "goal", text: goal });
    terminalLine("goal", goal.slice(0, 200));
    if (restored) {
      const resumeNote = restored.followUp
        ? `💬 CONTINUING the project from run ${restored.resumedFrom.runId.slice(0, 8)} — conversation memory restored (${restored.history.length} turns, ${restored.writtenPaths.size} files tracked). Your follow-up is appended below; the same tools, sandbox and failover chain apply.`
        : `⚡ RESUMED from run ${restored.resumedFrom.runId.slice(0, 8)} — conversation memory restored from the disk checkpoint (${restored.history.length} turns, ${restored.resumedFrom.steps} rounds done, ${restored.writtenPaths.size} files tracked). Whichever provider is healthy NOW continues the coding; workspace files were never touched.`;
      t.push({ type: "note", text: resumeNote });
      terminalLine("note", resumeNote);
    }
    await t.flush();

    // PREFLIGHT: fail fast + actionable when no LLM provider is
    // configured (Claude Code behavior: it tells you to add a key
    // instead of silently producing nothing — the #1 cause of
    // "the agent is not creating any files" on a fresh install).
    // Shared with the job agent so every surface has one voice.
    const pre = await assertProviderConfigured();
    if (!pre.ok) {
      const message = pre.message;
      t.push({ type: "error", text: message });
      await db.agentRun
        .update({
          where: { id: runId },
          data: {
            status: "failed",
            result: message,
            steps: JSON.stringify(t.steps),
            stepCount: t.steps.length,
            provider: "none",
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
      return;
    }

    // Project memory (CLAUDE.md parity): workspace/AGENT.md — a RESUMED
    // history already embeds it, so only fresh runs re-inject the goal.
    if (!restored) {
      const memory = await readAgentMemory();
      const goalWithMemory = memory
        ? `${goal}\n\n--- PROJECT MEMORY (workspace/AGENT.md — persistent preferences from previous runs) ---\n${memory}`
        : goal;
      if (memory) t.push({ type: "note", text: "Loaded workspace/AGENT.md project memory." });

      // v3.5 EXTERNAL MCP — github-mcp-server (docker/remote) and any
      // other MCP server from mcp.config.json becomes agent tools.
      const mcp = await loadExternalMcpTools();
      mcpCleanup = mcp.cleanup;
      const tools: ToolDef[] = mcp.tools.length > 0 ? [...CODING_TOOLS, ...mcp.tools] : CODING_TOOLS;
      if (mcp.notes.length > 0) {
        for (const note of mcp.notes) t.push({ type: "note", text: note });
        await t.flush();
      }

      history.push({ role: "user", text: goalWithMemory });
      return await driveLoop(runId, goal, { history, tokens, providerUsed, writtenPaths, rounds: 0, tools, t, startedAt, mcpCleanup });
    }

    // Resumed run: reload MCP tools fresh (servers may have changed),
    // then continue the loop with the restored memory.
    const mcp2 = await loadExternalMcpTools();
    mcpCleanup = mcp2.cleanup;
    const tools2: ToolDef[] = mcp2.tools.length > 0 ? [...CODING_TOOLS, ...mcp2.tools] : CODING_TOOLS;
    if (mcp2.notes.length > 0) {
      for (const note of mcp2.notes) t.push({ type: "note", text: note });
      await t.flush();
    }

    // v4.2 — chat-continue: append the user's follow-up WITH a live
    // workspace-tree refresh so the model sees the CURRENT state of
    // the project it built earlier (vscode-copilot-chat follow-up turn).
    if (restored.followUp) {
      const treeTool = tools2.find((t2) => t2.name === "fs_tree");
      let treeText = "(fs_tree unavailable)";
      try {
        if (treeTool) treeText = JSON.stringify(await treeTool.execute({})).slice(0, 3000);
      } catch (e) {
        treeText = `(tree refresh failed: ${(e as Error).message})`;
      }
      history.push({
        role: "user",
        text: `CONTINUE THIS PROJECT — follow-up request from the user:\n\n${restored.followUp}\n\nCURRENT WORKSPACE STATE (fs_tree, for reference — files from the previous run are on disk):\n${treeText}\n\nApply the requested changes with the same engineering discipline: inspect with fs_tree/fs_read first if needed, edit surgically, run + verify, then give the standard final report (what changed, how to run, verification evidence).`,
      });
      t.push({ type: "note", text: `💬 Follow-up received: “${restored.followUp.slice(0, 160)}” — continuing with full project memory.` });
      terminalLine("note", `💬 follow-up: ${restored.followUp.slice(0, 120)}`);
      await t.flush();
    }

    await driveLoop(runId, goal, { history, tokens, providerUsed, writtenPaths, rounds: effectiveRounds, tools: tools2, t, startedAt, mcpCleanup });
  } finally {
    mcpCleanup?.();
    if (g.__agentBusyRunId === runId) g.__agentBusyRunId = null;
    g.__agentStopRequested = false;
  }
}

// ── v3.7 unified agent loop (fresh runs + resumes share this) ──
async function driveLoop(
  runId: string,
  goal: string,
  s: {
    history: HistoryTurn[];
    tokens: number;
    providerUsed: string;
    writtenPaths: Set<string>;
    rounds: number;
    tools: ToolDef[];
    t: CodingTranscript;
    startedAt: number;
    mcpCleanup: (() => void) | null;
  }
): Promise<void> {
  const { t } = s;
  const tools = s.tools;
  const startedAt = s.startedAt;
  let history = s.history;
  let tokens = s.tokens;
  let providerUsed = s.providerUsed;
  const writtenPaths = s.writtenPaths;
  let rounds = s.rounds;
  const system = await buildCodingSystemPrompt(tools);
  let truncationNudges = 0;
  // v3.7 patience context — handed to every generate call.
  const patienceCtx: PatienceCtx = {
    t,
    startedAt,
    budgetMs: OVERALL_BUDGET_MS,
    busy: () => g.__agentBusyRunId === runId,
  };
  // v3.7 checkpoint — the run's resume memory, refreshed every round.
  const persistCheckpoint = async () => {
    await saveCheckpoint({
      version: 1,
      runId,
      goal,
      history,
      writtenPaths: [...writtenPaths],
      rounds,
      tokens,
      providerUsed,
      savedAt: Date.now(),
    });
  };
  try {
    while (rounds < MAX_TOOL_ROUNDS) {
      if (g.__agentStopRequested) {
        t.push({ type: "note", text: "Stop requested by user — wrapping up." });
        break;
      }
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
        t.push({ type: "note", text: "Time budget reached — wrapping up." });
        break;
      }

      // v3.7 AUTO-COMPACT — deterministic marathon-context safety.
      if (jsonLen(history) > HISTORY_SOFT_MAX_CHARS) {
        const before = jsonLen(history);
        history = compactHistoryDigest(history);
        t.push({
          type: "note",
          text: `Auto-compacted the conversation (${Math.round(before / 1000)}KB → ${Math.round(jsonLen(history) / 1000)}KB) — older tool outputs became one-line digests; the plan, code and recent context stay full.`,
        });
      }

      // v4.0 LIVE STREAMING — token fragments flow to the browser
      // WHILE the model generates (throttled to ~8 events/s so SSE
      // never floods); onReset clears the partial text when a retry
      // restarts generation so nothing is shown twice.
      // v4.1 — thinking models (GLM-5.2, Nemotron) stream their
      // chain-of-thought on a SEPARATE reasoning channel: throttled
      // to ~2 events/s, shown live as “thinking…” in the console.
      let liveBuf = "";
      let lastDeltaAt = 0;
      let reasonBuf = "";
      let lastReasonAt = 0;
      let roundReasonChars = 0;
      const flushLive = () => {
        if (liveBuf.length === 0) return;
        publishDelta(runId, liveBuf);
        liveBuf = "";
      };
      const streamOpts: GenerateOpts = {
        onDelta: (frag) => {
          liveBuf += frag;
          const now = Date.now();
          if (now - lastDeltaAt > 125 || liveBuf.length > 500) {
            lastDeltaAt = now;
            flushLive();
          }
        },
        onReasoning: (frag) => {
          roundReasonChars += frag.length;
          reasonBuf += frag;
          const now = Date.now();
          if (now - lastReasonAt > 500 || reasonBuf.length > 800) {
            lastReasonAt = now;
            publishReasoning(runId, reasonBuf);
            reasonBuf = "";
          }
        },
        onReset: () => {
          liveBuf = "";
          reasonBuf = "";
          publish(`run:${runId}`, "delta_reset", {});
        },
      };

      // v3.7 SPEED + HANDOFF + ROUND STATS: generateWithPatience holds
      // the memory and retries when EVERY provider is down; the chain
      // inside hands off provider→provider on a single death.
      const roundStart = Date.now();
      const { response, provider, handoff } = await generateWithPatience(history, system, tools, patienceCtx, streamOpts);
      flushLive();
      if (reasonBuf.length > 0) {
        publishReasoning(runId, reasonBuf);
        reasonBuf = "";
      }
      publish(`run:${runId}`, "delta_end", {});
      const roundSec = ((Date.now() - roundStart) / 1000).toFixed(1);
      tokens += response.tokens;
      if (handoff) {
        t.push({ type: "note", text: `⚡ HANDOFF: ${handoff}` });
        terminalLine("handoff", `⚡ HANDOFF: ${handoff}`);
      }
      // v4.1 — reasoning summary: thinking models streamed their
      // chain-of-thought; one compact line in the terminal feed.
      if (roundReasonChars > 0) {
        terminalLine("note", `🧠 thought for ${roundReasonChars} chars of reasoning before answering`);
      }
      const usageNote = formatUsageNote(response.usage);
      const modelTag = response.model ? `${provider}·${response.model}` : provider;
      const roundNote = `${modelTag} · round ${rounds + 1} · ${roundSec}s · +${response.tokens.toLocaleString()} tok${usageNote}`;
      t.push({ type: "note", text: roundNote });
      terminalLine("round", `── ${roundNote} ──`);
      publishUsage(runId, {
        round: rounds + 1,
        provider,
        ...(response.model ? { model: response.model } : {}),
        tokens: response.tokens,
        cumulative: tokens,
        ...(response.usage ? { usage: response.usage as Record<string, unknown> } : {}),
      });
      if (response.text) terminalLine("assistant", response.text.slice(0, 400));
      if (provider !== providerUsed) {
        t.push({ type: "note", text: `LLM provider: ${provider}` });
        providerUsed = providerUsed ? `${providerUsed}→${provider}` : provider;
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        if (response.text) t.push({ type: "assistant", text: response.text });
        // rawParts = the EXACT Gemini parts (thoughtSignature included) —
        // replaying them verbatim is what keeps long multi-tool runs
        // alive on Gemini 2.5 thinking models (v3.4 fix).
        history.push({ role: "model", text: response.text, toolCalls: response.toolCalls, rawParts: response.rawParts });
        const results: Array<{ name: string; result: unknown }> = [];

        // v4.0 TURBO — announce every call up front (console + xterm see
        // the whole queue instantly), then execute via parallel groups:
        // consecutive read-only calls run CONCURRENTLY, mutating calls
        // run alone and in order (openclaude partitionToolCalls).
        for (const call of response.toolCalls) {
          t.push({ type: "tool_call", name: call.name, args: call.args });
          terminalLine("tool", toolCallLine(call));
        }
        await t.flush({ tokensUsed: tokens, provider: providerUsed || provider });

        const execOne = async (call: AgentToolCall): Promise<unknown> => {
          const rl = rateLimit("tool", "coding");
          if (!rl.allowed) {
            const wait = Math.min(rl.retryAfterMs, 30_000);
            const noteText = `Tool rate limit — waiting ${Math.round(wait / 1000)}s (limits: ${JSON.stringify(rateLimitStatus())})`;
            t.push({ type: "note", text: noteText });
            terminalLine("note", noteText);
            await new Promise((r) => setTimeout(r, wait));
          }
          const tool = tools.find((x) => x.name === call.name);
          return tool
            ? await tool.execute(call.args ?? {}).catch((e: Error) => ({ error: `tool failed: ${e.message}` }))
            : { error: `unknown tool: ${call.name}` };
        };

        const groups = partitionToolCalls(response.toolCalls);
        for (const group of groups) {
          const parallel = group.length > 1;
          const settled = parallel
            ? await Promise.all(group.map((c) => execOne(c)))
            : [await execOne(group[0])];
          for (let gi = 0; gi < group.length; gi++) {
            const call = group[gi];
            const raw = settled[gi];
            const result = compactToolResult(raw);
            const { summary, preview } = summarizeCodingResult(raw);
            t.push({ type: "tool_result", name: call.name, summary, preview });
            terminalLine("result", `${call.name} → ${summary}${parallel ? " (parallel)" : ""}`);
            results.push({ name: call.name, result });
            // v3.5 accuracy layer + v4.0 fs_batch expansion: remember
            // every path the agent WROTE so the final report can be
            // cross-checked against the disk.
            if (WRITE_TOOLS.has(call.name) && !(raw as { error?: unknown }).error) {
              for (const p of trackWrittenPaths(call.name, call.args ?? {})) writtenPaths.add(p);
            }
          }
          await t.flush({ tokensUsed: tokens, provider: providerUsed || provider });
        }
        // Truncation nudge: a trailing call was cut off mid-JSON — make the
        // model aware so it re-issues it (Claude-Code-style continuation).
        if (response.truncatedToolCall && truncationNudges < 5) {
          truncationNudges++;
          const note = `NOTE: your previous message ALSO contained a tool call that was cut off mid-output by the token limit and was NOT executed: ${response.truncatedToolCall.slice(0, 200)}… Re-issue that call with SHORTER content — split large files into multiple ops (fs_write under 60 lines each, or several write ops in one fs_batch).`;
          history.push({ role: "toolResults", results: [...results, { name: "system_note", result: { note } }] });
          t.push({ type: "note", text: "Model output was truncated — nudging it to re-issue the cut-off call in smaller chunks." });
        } else {
          history.push({ role: "toolResults", results });
        }
        await t.flush({ tokensUsed: tokens, provider: providerUsed });
        rounds++;
        await persistCheckpoint(); // v3.7: resume memory refreshed after every round
        continue;
      }

      // Truncated tool call with nothing else usable — corrective turn
      if (
        (response.truncatedToolCall || /^\s*\{\s*"tool/.test(response.text ?? "")) &&
        truncationNudges < 5
      ) {
        truncationNudges++;
        t.push({ type: "note", text: "Model output hit the token limit mid-tool-call — asking for a re-issue in smaller chunks." });
        history.push({ role: "model", text: response.text });
        history.push({
          role: "user",
          text: "Your last message was TRUNCATED by the output token limit before the JSON completed, so nothing executed. Re-issue the tool call now with SHORTER content — split large files into multiple fs_write calls (each under 60 lines). Never emit anything after the closing JSON brace.",
        });
        await t.flush();
        rounds++;
        continue;
      }

      // Plain text → final answer. v3.4 stall fix: an EMPTY answer no
      // longer completes the run — that was the "(no final answer
      // produced)" dead end after repeated truncation. Fall through to
      // the forced wrap-up turn so every run ends with a real report.
      const finalText = response.text?.trim() || "";
      if (finalText) {
        const readmeNote = await ensureProjectReadme(goal); // v4.2 — README.md by default
        const verification = await verifyArtifacts(writtenPaths);
        const fullFinal = [finalText, verification, readmeNote].filter(Boolean).join("\n\n");
        t.push({ type: "final", text: fullFinal });
        if (readmeNote) {
          t.push({ type: "note", text: readmeNote });
          terminalLine("note", readmeNote);
        }
        terminalLine("final", fullFinal.slice(0, 500));
        await db.agentRun.update({
          where: { id: runId },
          data: {
            status: "completed",
            result: fullFinal,
            steps: JSON.stringify(t.steps),
            stepCount: t.steps.length,
            tokensUsed: tokens,
            provider: providerUsed || provider,
            finishedAt: new Date(),
          },
        });
        // v4.2 — keep the conversation so the user can chat-continue
        // the project (Copilot-Chat-style follow-up turns).
        await saveConversationSnapshot({
          runId,
          goal,
          history,
          writtenPaths: [...writtenPaths],
          tokens,
          providerUsed: providerUsed || provider,
          rounds,
        });
        await clearCheckpoint(runId); // v3.7: run finished cleanly — resume memory retired
        return;
      }
      t.push({ type: "note", text: "Model produced no usable output (repeated truncation or empty reply) — forcing a wrap-up summary turn." });
      break;
    }

    // Budget exhausted or stalled → forced wrap-up. The executed-action
    // list is FACTUAL GROUNDING from the transcript: without it the model
    // invents files it never wrote (observed live — claimed index.html +
    // server.js existed while workspace/dashboard was empty).
    const executedActions =
      t.steps
        .filter((s) => s.type === "tool_result")
        .map((s) => `- ${s.name} → ${s.summary ?? "ok"}`)
        .join("\n") || "- (no tools executed)";
    history.push({
      role: "user",
      text: `Step or time budget reached (or the model stalled). Wrap up NOW: report what you built, the file tree, how to run it, and any verification evidence, in your final answer.\n\nACTUAL EXECUTED ACTIONS (the ONLY work that really happened — your report must match this list exactly; never claim files or servers that are not in it):\n${executedActions}`,
    });
    const { response, provider } = await generateWithAuto(history, [], system);
    tokens += response.tokens;
    if (provider !== providerUsed) providerUsed = `${providerUsed}→${provider}`;
    const readmeNote = await ensureProjectReadme(goal); // v4.2 — README.md by default
    const verification = await verifyArtifacts(writtenPaths);
    const finalText =
      (response.text?.trim() || "(budget exhausted before a final answer)") +
      [verification, readmeNote].filter(Boolean).map((s) => `\n\n${s}`).join("");
    t.push({ type: "final", text: finalText });
    if (readmeNote) {
      t.push({ type: "note", text: readmeNote });
      terminalLine("note", readmeNote);
    }
    terminalLine("final", finalText.slice(0, 500));
    await db.agentRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        result: finalText,
        steps: JSON.stringify(t.steps),
        stepCount: t.steps.length,
        tokensUsed: tokens,
        provider: providerUsed,
        finishedAt: new Date(),
      },
    });
    // v4.2 — chat-continue memory for budget-exhausted completions too
    await saveConversationSnapshot({
      runId,
      goal,
      history,
      writtenPaths: [...writtenPaths],
      tokens,
      providerUsed,
      rounds,
    });
    await clearCheckpoint(runId); // v3.7: budget exhausted but reported cleanly — retire the checkpoint
  } catch (e) {
    // Raw SDK text (e.g. the cryptic z-ai init error) never becomes the
    // run's failure text — translate it to the actionable message.
    const message = diagnoseRunError(e);
    // Graceful degradation: real work already done → synthesize an honest
    // final report from the transcript instead of discarding the run.
    const didWork = t.steps.some((s) => s.type === "tool_result");
    if (didWork) {
      t.push({
        type: "note",
        text: `LLM became unavailable late in the run (${message.slice(0, 140)}) — synthesizing the report from the transcript. A disk checkpoint with the full conversation was KEPT: press RESUME on this run to continue coding with the next healthy model.`,
      });
      const finalText = synthesizeCodingReport(t, goal, message);
      t.push({ type: "final", text: finalText });
      terminalLine("final", finalText.slice(0, 500));
      const readmeNote = await ensureProjectReadme(goal); // v4.2 — README.md by default, even on degradation
      if (readmeNote) {
        t.push({ type: "note", text: readmeNote });
        terminalLine("note", readmeNote);
      }
      await db.agentRun
        .update({
          where: { id: runId },
          data: {
            status: "completed",
            result: readmeNote ? `${finalText}\n\n${readmeNote}` : finalText,
            steps: JSON.stringify(t.steps),
            stepCount: t.steps.length,
            tokensUsed: tokens,
            provider: providerUsed,
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
      // v4.2 — the degraded run's conversation is ALSO kept for
      // chat-continue (plus the checkpoint below for RESUME).
      await saveConversationSnapshot({
        runId,
        goal,
        history,
        writtenPaths: [...writtenPaths],
        tokens,
        providerUsed,
        rounds,
      });
      await persistCheckpoint(); // v3.7: deliberately KEPT so the run can be resumed
      return;
    }
    t.push({ type: "error", text: message });
    terminalLine("error", message);
    await db.agentRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          result: `Coding run failed: ${message}`,
          steps: JSON.stringify(t.steps),
          stepCount: t.steps.length,
          tokensUsed: tokens,
          provider: providerUsed,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }
}
