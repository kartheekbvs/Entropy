// ─────────────────────────────────────────────────────────────
// Autonomous agent runner — Claude-Code-style tool-use loop.
// Executes a natural-language goal using the shared tool registry,
// persisting a live transcript to the AgentRun table so the UI
// can poll it in real time.
// ─────────────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { AGENT_TOOLS, executeTool } from "./tools";
import { generateWithAuto, compactToolResult, assertProviderConfigured, diagnoseRunError, type HistoryTurn } from "./llm";

export interface AgentStep {
  i: number;
  ts: number;
  type: "goal" | "assistant" | "tool_call" | "tool_result" | "note" | "final" | "error";
  text?: string;
  name?: string;
  args?: unknown;
  summary?: string;
  preview?: string;
}

// v3.4 MARATHON LIMITS (job agent): 40 LLM rounds (was 14), 30-minute
// budget (was 8). Env-tunable: AGENT_MAX_ROUNDS / AGENT_BUDGET_MINUTES.
// v3.5: 40→60 rounds, 30→45 minutes (marathon parity with the coding agent).
const roundLimit = () => {
  const v = Number(process.env["AGENT_MAX_ROUNDS"]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 60;
};
const MAX_TOOL_ROUNDS = roundLimit();
const budgetMinutes = () => {
  const v = Number(process.env["AGENT_BUDGET_MINUTES"]);
  return Number.isFinite(v) && v > 0 ? v : 45;
};
const OVERALL_BUDGET_MS = budgetMinutes() * 60 * 1000;

// ── Busy lock + stop flag (survive HMR via globalThis) ───────
const g = globalThis as unknown as {
  __agentBusyRunId?: string | null;
  __agentStopRequested?: boolean;
};

export function isAgentBusy(): boolean {
  return Boolean(g.__agentBusyRunId);
}

export function activeRunId(): string | null {
  return g.__agentBusyRunId ?? null;
}

export function requestStop(): boolean {
  if (!g.__agentBusyRunId) return false;
  g.__agentStopRequested = true;
  return true;
}

// ── System prompt ────────────────────────────────────────────
function buildSystemPrompt(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `You are KARTHEEK'S AUTONOMOUS JOB-HUNT AGENT — an operations agent inside his Job Hunt Command Center. Today is ${date}.

CANDIDATE (ground truth):
- B.V.S. Kartheek — BE Computer Engineering, Chandigarh University, CGPA 8.3, 2023–2027 (final year)
- AI/ML Intern @ InternPro (Remote, Jul–Sep 2025): Python automation for 15+ teams, 40+ issues resolved, 99% uptime
- Projects: spam classifier (scikit-learn, TF-IDF, 94% accuracy, 10k+ emails), TWSS learning platform, portfolio
- Skills: Python, SQL, scikit-learn, ML, AWS, data analysis
- Targets: ML/AI + Data and Python Developer roles · intern/entry level · Hyderabad, Bengaluru, Chandigarh/Mohali, Visakhapatnam, or open remote

OPERATING PRINCIPLES:
1. Be autonomous. Use tools to gather real data, make decisions, and act. Never ask questions mid-run — decide and report.
2. Ground EVERYTHING in tools. Real job data comes only from search_public_jobs (live public ATS feeds). Tracker state only from list/add/update tools. Board links only from get_board_links. NEVER fabricate URLs, companies, scores, or contacts.
3. Act on the tracker: jobs worth pursuing get added via add_application, with notes stating the match score and why it fits. Check list_applications first to avoid duplicates (the tool also auto-dedupes).
4. QUALITY BAR for adding jobs: only add engineering/data roles that fit his ML/AI + Python targets — check the job's matchScore (add only >= 45, prefer >= 60) and seniority (intern/entry ideal; clearly senior or non-technical roles like HR, finance, audit, sales, or office assistant are NEVER worth adding — even if they appear in search results). If a search returns mostly irrelevant roles, refine the search (different role track, keywords, or location) instead of adding weak matches. An honest "no good fits today" beats tracker noise.
5. Writing tasks (cover letters, outreach) go through ai_write with full context.
6. Be efficient: search with narrow filters (role + location + keywords like "intern"), keep limits modest, don't repeat identical searches.

FINAL ANSWER (when the goal is complete) — concise markdown, under 350 words:
1. WHAT YOU DID — tools called, real sources touched
2. KEY RESULTS — jobs added/notable findings with their REAL URLs from tool results
3. NEXT ACTIONS — what Kartheek should do today (specific, prioritized)
If any sources failed, say so honestly.`;
}

// ── Transcript helpers ───────────────────────────────────────
class Transcript {
  steps: AgentStep[] = [];
  constructor(private runId: string, private goal: string) {}

  push(step: Omit<AgentStep, "i" | "ts">) {
    this.steps.push({ ...step, i: this.steps.length + 1, ts: Date.now() });
  }

  async flush(extra: Record<string, unknown> = {}) {
    try {
      await db.agentRun.update({
        where: { id: this.runId },
        data: { steps: JSON.stringify(this.steps), stepCount: this.steps.length, ...extra },
      });
    } catch {
      // transcript persistence is best-effort; the run continues
    }
  }
}

function summarizeToolResult(result: unknown): { summary: string; preview: string } {
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
    if (typeof r.totalFound === "number") {
      summary = `${r.totalFound} jobs found · ${(r.jobs as unknown[])?.length ?? 0} returned · ${(r.sources as { ok?: unknown[] })?.ok?.length ?? "?"} sources live`;
    } else if (typeof r.count === "number") {
      summary = `${r.count} records`;
    } else if (typeof r.score === "number") {
      summary = `match score ${r.score} · ${(r.matched as unknown[])?.length ?? 0} matched · ${(r.missing as unknown[])?.length ?? 0} missing`;
    } else if (typeof r.created === "boolean") {
      summary = r.created ? "created" : "deduped/updated";
    } else if (typeof r.text === "string") {
      summary = `written ${r.text.length} chars`;
    } else if (r.error) {
      summary = `error: ${String(r.error).slice(0, 80)}`;
    } else if (typeof r.total === "number") {
      summary = `${r.total} tracked · streak ${r.streakDays}d`;
    }
  }
  return { summary, preview };
}

// ── The loop ─────────────────────────────────────────────────
export async function startAgentRun(goal: string, mode: "manual" | "autopilot"): Promise<string> {
  const run = await db.agentRun.create({
    data: { goal, mode, status: "running", steps: "[]" },
  });
  g.__agentBusyRunId = run.id;
  g.__agentStopRequested = false;
  // Fire-and-forget; the API route returns the run id immediately and the UI polls
  void runAgent(run.id, goal, mode).catch(async (e) => {
    console.error(`agent run ${run.id} crashed:`, e);
    g.__agentBusyRunId = null;
    try {
      await db.agentRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          result: `Runner crashed: ${(e as Error).message}`,
          finishedAt: new Date(),
        },
      });
    } catch {
      /* ignore */
    }
  });
  return run.id;
}

/** Awaited variant used by the MCP server tool (returns the completed run). */
export async function runAgentToCompletion(
  goal: string,
  mode: "manual" | "autopilot" = "manual"
): Promise<{ id: string; status: string; provider: string; result: string; stepLog: string[] }> {
  if (g.__agentBusyRunId) throw new Error("another agent run is active in this process");
  const run = await db.agentRun.create({
    data: { goal, mode, status: "running", steps: "[]" },
  });
  g.__agentBusyRunId = run.id;
  g.__agentStopRequested = false;
  try {
    await runAgent(run.id, goal, mode);
  } finally {
    if (g.__agentBusyRunId === run.id) g.__agentBusyRunId = null;
    g.__agentStopRequested = false;
  }
  const row = await db.agentRun.findUnique({ where: { id: run.id } });
  const steps: AgentStep[] = row ? JSON.parse(row.steps || "[]") : [];
  return {
    id: run.id,
    status: row?.status ?? "unknown",
    provider: row?.provider ?? "",
    result: row?.result ?? "",
    stepLog: steps
      .filter((s) => s.type === "tool_call" || s.type === "note" || s.type === "error")
      .map((s) =>
        s.type === "tool_call" ? `${s.i}. tool: ${s.name}` : `${s.i}. ${s.type}: ${(s.text ?? "").slice(0, 100)}`
      ),
  };
}

// ── Graceful degradation: synthesize an honest report from the
// transcript when the LLM dies late in the run ─────────────────
function synthesizeJobReport(t: Transcript, goal: string, reason: string): string {
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
    `${results.length} tool results recorded:`,
  ];
  for (const s of results.slice(-14)) {
    lines.push(`- **${s.name}** → ${s.summary ?? "ok"}`);
  }
  lines.push("", "## NOTE", "Check the tracker and contacts tabs — all writes above are live. Re-run the same goal to continue.");
  return lines.join("\n");
}

async function runAgent(runId: string, goal: string, mode: "manual" | "autopilot"): Promise<void> {
  const t = new Transcript(runId, goal);
  const history: HistoryTurn[] = [];
  let tokens = 0;
  let providerUsed = "";
  const startedAt = Date.now();

  try {
    t.push({ type: "goal", text: goal });
    await t.flush();

    // PREFLIGHT: fail fast + actionable when no LLM provider is usable
    // (Claude Code behavior — same guarantee as the coding agent: no
    // cryptic "init failed: Configuration file not found…" errors, ever).
    const pre = await assertProviderConfigured();
    if (!pre.ok) {
      t.push({ type: "error", text: pre.message });
      await t.flush({ status: "failed", result: `Agent run failed: ${pre.message}`, provider: "none", finishedAt: new Date() });
      return;
    }

    history.push({ role: "user", text: goal });

    let rounds = 0;
    let truncationNudges = 0;
    while (rounds < MAX_TOOL_ROUNDS) {
      if (g.__agentStopRequested) {
        t.push({ type: "note", text: "Stop requested by user — wrapping up." });
        break;
      }
      if (Date.now() - startedAt > OVERALL_BUDGET_MS) {
        t.push({ type: "note", text: "Time budget reached — wrapping up." });
        break;
      }

      const { response, provider } = await generateWithAuto(history, AGENT_TOOLS, buildSystemPrompt());
      if (provider !== providerUsed) {
        t.push({
          type: "note",
          text: `LLM provider: ${provider}${provider === "zai" ? " (fallback — primary provider unavailable)" : " (native function calling)"}`,
        });
        providerUsed = provider;
      }
      tokens += response.tokens;

      // Tool calls → execute every call, append results
      if (response.toolCalls && response.toolCalls.length > 0) {
        if (response.text) t.push({ type: "assistant", text: response.text });
        // rawParts = the EXACT Gemini parts (thoughtSignature included) —
        // replayed verbatim so Gemini 2.5 thinking models never reject
        // the next request with "missing a thought_signature" (v3.4 fix).
        history.push({
          role: "model",
          text: response.text,
          toolCalls: response.toolCalls,
          rawParts: response.rawParts,
        });
        const results: Array<{ name: string; result: unknown }> = [];
        for (const call of response.toolCalls) {
          t.push({ type: "tool_call", name: call.name, args: call.args });
          await t.flush({ tokensUsed: tokens, provider: providerUsed || provider });
          const raw = await executeTool(call.name, call.args ?? {});
          const result = compactToolResult(raw);
          const { summary, preview } = summarizeToolResult(raw);
          t.push({ type: "tool_result", name: call.name, summary, preview });
          results.push({ name: call.name, result });
        }
        // A trailing tool call was cut off mid-JSON — tell the model so it
        // re-issues it instead of assuming it executed (truncation nudge).
        if (response.truncatedToolCall && truncationNudges < 5) {
          truncationNudges++;
          const note = `NOTE: your previous message ALSO contained a tool call that was cut off mid-output by the token limit and was NOT executed: ${response.truncatedToolCall.slice(0, 200)}… Re-issue that call with SHORTER content — split large files into multiple fs_write calls.`;
          history.push({ role: "toolResults", results: [...results, { name: "system_note", result: { note } }] });
          t.push({ type: "note", text: "Model output was truncated — nudging it to re-issue the cut-off call in smaller chunks." });
        } else {
          history.push({ role: "toolResults", results });
        }
        await t.flush({ tokensUsed: tokens, provider: providerUsed });
        rounds++;
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
          text: "Your last message was TRUNCATED by the output token limit before the JSON completed, so no tool ran. Re-issue the tool call now with SHORTER content — if the file is large, write it in multiple fs_write calls, each under 60 lines. Never emit anything after the closing JSON brace.",
        });
        await t.flush();
        rounds++;
        continue;
      }

      // Plain text → final answer. v3.4 stall fix: an EMPTY answer no
      // longer completes the run (the "(no final answer produced)" dead
      // end) — break to the forced wrap-up turn instead.
      const finalText = response.text?.trim() || "";
      if (finalText) {
        t.push({ type: "final", text: finalText });
        await db.agentRun.update({
          where: { id: runId },
          data: {
            status: "completed",
            result: finalText,
            steps: JSON.stringify(t.steps),
            stepCount: t.steps.length,
            tokensUsed: tokens,
            provider: providerUsed || provider,
            finishedAt: new Date(),
          },
        });
        return;
      }
      t.push({ type: "note", text: "Model produced no usable output (repeated truncation or empty reply) — forcing a wrap-up summary turn." });
      break;
    }

    // Step/time budget exhausted or stalled → force a wrap-up turn without
    // tools. Factual grounding from the transcript keeps the summary honest.
    const executedActions =
      t.steps
        .filter((s) => s.type === "tool_result")
        .map((s) => `- ${s.name} → ${s.summary ?? "ok"}`)
        .join("\n") || "- (no tools executed)";
    history.push({
      role: "user",
      text: `Step or time budget reached (or the model stalled). Wrap up NOW: summarize what you accomplished (jobs added, real URLs from tool results, next actions) in your final answer.\n\nACTUAL EXECUTED ACTIONS (the ONLY work that really happened — your report must match this list exactly):\n${executedActions}`,
    });
    const { response, provider } = await generateWithAuto(history, [], buildSystemPrompt());
    tokens += response.tokens;
    if (provider !== providerUsed) providerUsed = `${providerUsed}→${provider}`;
    const finalText = response.text?.trim() || "(budget exhausted before a final answer)";
    t.push({ type: "final", text: finalText });
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
        text: `LLM became unavailable late in the run (${message.slice(0, 140)}) — synthesizing the report from the transcript.`,
      });
      const finalText = synthesizeJobReport(t, goal, message);
      t.push({ type: "final", text: finalText });
      await db.agentRun
        .update({
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
        })
        .catch(() => undefined);
      return;
    }
    t.push({ type: "error", text: message });
    await db.agentRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          result: `Agent run failed: ${message}`,
          steps: JSON.stringify(t.steps),
          stepCount: t.steps.length,
          tokensUsed: tokens,
          provider: providerUsed,
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined);
  } finally {
    if (g.__agentBusyRunId === runId) g.__agentBusyRunId = null;
    g.__agentStopRequested = false;
  }
}
