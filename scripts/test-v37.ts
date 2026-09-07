// ─────────────────────────────────────────────────────────────
// v3.7 IRON-MAN RELIABILITY TESTS
//   1. SPEED       — one Groq gpt-oss round with reasoning_effort
//                    "low" (the fix for "552s · 6 tool calls")
//   2. HANDOFF     — poison the active provider mid-conversation →
//                    the chain hands memory to the next provider and
//                    generateWithAuto reports the handoff note
//   3. RESUME      — fabricate a crashed run + disk checkpoint →
//                    resumeCodingAgentRun() restores the memory and
//                    the NEXT provider finishes the job
//   4. STALE-RUN   — a "running" row not owned by any live process is
//                    re-labeled "interrupted" by GET /api/agent/runs
//                    (driven against the dev server on :3000)
//
// Run: bun scripts/test-v37.ts
// ─────────────────────────────────────────────────────────────
process.env.MCP_MODE = "1";

import { promises as fs } from "node:fs";
import path from "node:path";

const WORKSPACE = path.resolve(process.cwd(), "workspace");
const STATE_DIR = path.join(WORKSPACE, ".agent-state");
const PROOF = path.join(WORKSPACE, "resume-proof.txt");
const SECRET = "pineapple-pizza";

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

console.log("═".repeat(64));
console.log("v3.7 IRON-MAN RELIABILITY TESTS");
console.log("═".repeat(64));

// Phase filter: bun scripts/test-v37.ts [all|speed|handoff|resume|stale]
const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

// ── 1. SPEED — a single tiny round on the live primary provider ──
if (want("speed")) {
console.log("\n── 1. SPEED (reasoning_effort=low) ──");
try {
  const { generateWithAuto } = await import("../src/lib/agent/llm");
  const t0 = Date.now();
  const { response, provider } = await generateWithAuto(
    [{ role: "user", text: "Reply with the single word: ok" }],
    [],
    "You are a latency probe. Answer in one word."
  );
  const secs = (Date.now() - t0) / 1000;
  check(
    `provider responded fast (${provider}, ${(response.text ?? "").trim().slice(0, 20)})`,
    secs < 60 && Boolean(response.text),
    `${secs.toFixed(1)}s`
  );
} catch (e) {
  check("provider responded fast", false, (e as Error).message.slice(0, 120));
}
}

// ── 2. HANDOFF — active provider dies, next takes the memory ──
if (want("handoff")) {
console.log("\n── 2. HANDOFF (provider dies mid-conversation) ──");
try {
  const { generateWithAuto } = await import("../src/lib/agent/llm");
  // Prime the memoized active provider to GROQ (the user's primary).
  // In this build sandbox Groq is edge-blocked (403 pre-auth) — which is
  // PERFECT for this test: the "model stopped working" case is real.
  (globalThis as Record<string, unknown>)["__agentLlmAutoState"] = {
    active: "groq",
    reason: "primed for handoff test",
    decidedAt: Date.now(),
  };
  const second = await generateWithAuto(
    [
      { role: "user" as const, text: "Remember the secret word: pineapple-pizza." },
      { role: "user" as const, text: "What was the secret word? One word." },
    ],
    [],
    "You are a memory keeper."
  );
  check(
    "dead provider fell over to a healthy one",
    second.provider !== "groq",
    `groq → ${second.provider}`
  );
  check(
    "handoff note reported with memory preserved",
    Boolean(second.handoff) && /took over/i.test(second.handoff ?? ""),
    (second.handoff ?? "").slice(0, 130)
  );
  const text = (second.response.text ?? "").toLowerCase();
  check(
    "the successor answered from the preserved memory",
    text.includes("pineapple"),
    text.slice(0, 40)
  );
} catch (e) {
  check("handoff", false, (e as Error).message.slice(0, 120));
}
}

// ── 3. RESUME — crashed run + checkpoint → next model continues ──
const { db } = await import("../src/lib/db");
const { resumeCodingAgentRun } = await import("../src/lib/agent/coding-runner");
if (want("resume")) {
console.log("\n── 3. RESUME (crash checkpoint → memory restored) ──");
try {
  await fs.rm(PROOF, { force: true });
  const GOAL = `Create the file resume-proof.txt in the workspace root containing exactly the secret word '${SECRET}' (lowercase, no quotes), then finish with a one-line report.`;

  // Fabricate the crashed run + its checkpoint (as the runner would
  // have written after round 1).
  const crashed = await db.agentRun.create({
    data: { goal: GOAL, mode: "coding", status: "interrupted", steps: "[]" },
  });
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(
    path.join(STATE_DIR, `${crashed.id}.json`),
    JSON.stringify({
      version: 1,
      runId: crashed.id,
      goal: GOAL,
      history: [
        {
          role: "user",
          text: `${GOAL}\n\n--- PROJECT MEMORY (workspace/AGENT.md — persistent preferences from previous runs) ---\n(none yet)`,
        },
        { role: "model", text: "I will create the file now.", toolCalls: [{ name: "todo_write", args: { todos: [] } }] },
      ],
      writtenPaths: [],
      rounds: 1,
      tokens: 0,
      providerUsed: "groq",
      savedAt: Date.now(),
    }),
    "utf8"
  );

  // Resume it — the next healthy provider continues with this memory.
  const res = await resumeCodingAgentRun(crashed.id);
  check("resume accepted", res.ok, res.message.slice(0, 110));

  if (res.ok && res.runId) {
    // SSE probe while the resumed run is live (dev server reads the
    // same DB): confirm the events stream pushes updates.
    let sseEvents = 0;
    const sseController = new AbortController();
    const sse = fetch(`http://localhost:3000/api/agent/events?id=${res.runId}`, {
      signal: sseController.signal,
    })
      .then(async (r) => {
        if (!r.body) return;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (dec.decode(value).includes("data:")) sseEvents++;
        }
      })
      .catch(() => undefined);

    // Poll the resumed run to completion.
    const deadline = Date.now() + 8 * 60 * 1000;
    let row = await db.agentRun.findUnique({ where: { id: res.runId } });
    while (row?.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      row = await db.agentRun.findUnique({ where: { id: res.runId! } });
    }
    check(
      `resumed run finished (${row?.status})`,
      row?.status === "completed",
      `${row?.stepCount ?? 0} steps`
    );

    const steps = JSON.parse(row?.steps ?? "[]") as Array<{ type: string; text?: string }>;
    check(
      "transcript shows the ⚡ RESUMED memory-restored note",
      steps.some((s) => s.type === "note" && (s.text ?? "").startsWith("⚡ RESUMED"))
    );
    check(
      "round stats are visible in the transcript",
      steps.some((s) => s.type === "note" && / · round \d+ · [\d.]+s · \+/i.test(s.text ?? ""))
    );
    try {
      const content = await fs.readFile(PROOF, "utf8");
      check(
        "the resumed agent finished the crashed run's job",
        content.trim() === SECRET,
        content.trim().slice(0, 40)
      );
    } catch {
      check("the resumed agent finished the crashed run's job", false, "file missing");
    }
    // new run's checkpoint should be retired on clean completion
    await new Promise((r) => setTimeout(r, 1000));
    let newCp = false;
    try {
      await fs.access(path.join(STATE_DIR, `${res.runId}.json`));
      newCp = true;
    } catch {
      /* absent — expected */
    }
    check("clean completion retires the new checkpoint", !newCp);

    sseController.abort();
    await Promise.race([sse, new Promise((r) => setTimeout(r, 2000))]);
    check(
      "SSE /api/agent/events streamed live events",
      sseEvents > 0,
      `${sseEvents} events`
    );
  }
} catch (e) {
  check("resume", false, (e as Error).message.slice(0, 120));
}
}

// ── 4. STALE-RUN re-labeling via the HTTP runs list ──
if (want("stale")) {
console.log("\n── 4. STALE-RUN re-labeling (GET /api/agent/runs) ──");
let ghostId: string | null = null;
try {
  const ghost = await db.agentRun.create({
    data: { goal: "ghost run that never finished", mode: "coding", status: "running", steps: "[]" },
  });
  ghostId = ghost.id;
  // SSE probe FIRST (while the row is still "running"): the events
  // stream should push an update + heartbeat pings immediately.
  try {
    const ac = new AbortController();
    let sseCount = 0;
    const probe = fetch(`http://127.0.0.1:3000/api/agent/events?id=${ghost.id}`, {
      signal: ac.signal,
    }).then(async (r) => {
      if (!r.body) return;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined as undefined }));
        if (done) break;
        if (dec.decode(value).includes("data:")) sseCount++;
      }
      ac.abort();
    });
    await Promise.race([probe, new Promise((r) => setTimeout(r, 5000))]);
    ac.abort();
    check("SSE /api/agent/events pushes live events", sseCount > 0, `${sseCount} events in 4s`);
  } catch (e) {
    check("SSE /api/agent/events pushes live events", false, (e as Error).message.slice(0, 100));
  }
  const res = await fetch("http://127.0.0.1:3000/api/agent/runs?limit=12", {
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { runs: Array<{ id: string; status: string; resumable: boolean }> };
  const me = data.runs.find((r) => r.id === ghost.id);
  check("orphaned 'running' row re-labeled interrupted", me?.status === "interrupted");
  const row = await db.agentRun.findUnique({ where: { id: ghost.id } });
  check("DB persisted the interrupted status", row?.status === "interrupted");
} catch (e) {
  check("stale-run relabeling", false, (e as Error).message.slice(0, 120));
} finally {
  if (ghostId) {
    await db.agentRun.delete({ where: { id: ghostId } }).catch(() => undefined);
  }
}
}

console.log("\n" + "═".repeat(64));
if (failures.length === 0) {
  console.log("✅ v3.7 IRON-MAN TESTS PASSED");
} else {
  console.log(`❌ FAILED (${failures.length}): ${failures.join(" · ")}`);
  process.exitCode = 1;
}
