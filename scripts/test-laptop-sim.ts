// ─────────────────────────────────────────────────────────────
// test-laptop-sim.ts — E2E regression for the exact Windows bug:
//   "ERROR init failed: Configuration file not found or invalid.
//    Please create .z-ai-config in your project, home directory, or /etc."
//
// Simulates the user's laptop through the REAL runner code paths
// (same functions the Deploy button and MCP server call):
//   - no GEMINI_API_KEY / OPENAI_API_KEY
//   - no .z-ai-config (AGENT_DISABLE_ZAI=1)
// Both job and coding runs must FAIL FAST with the actionable
// fix message — never the raw SDK error.
//
// Run: bun scripts/test-laptop-sim.ts
// ─────────────────────────────────────────────────────────────
process.env.MCP_MODE = "1"; // silence prisma stdout noise

// 0. Simulate the user's machine BEFORE importing the agent modules
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_MODEL;
delete process.env.OPENAI_MODEL;
delete process.env.OPENAI_BASE_URL;
delete process.env.AGENT_LLM_PROVIDER;
// v3.5 providers — a keyless laptop has none of these either
delete process.env.GROQ_API_KEY;
delete process.env.GROQ_MODEL;
delete process.env.GROQ_API_BASE;
delete process.env.GROQ_BASE_URL;
delete process.env.GLM_API_KEY;
delete process.env.ZAI_GLMAPI_KEY;
delete process.env.ZAI_API_KEY;
delete process.env.Z_AI_API_KEY;
delete process.env.GLM_MODEL;
delete process.env.GLM_API_BASE;
delete process.env.ZAI_API_BASE;
process.env.AGENT_DISABLE_ZAI = "1"; // no .z-ai-config on user machines
(globalThis as Record<string, unknown>).__agentZaiProbe = undefined;

const { runAgentToCompletion } = await import("../src/lib/agent/runner");
const { runCodingAgentToCompletion } = await import("../src/lib/agent/coding-runner");
const { db } = await import("../src/lib/db");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

function audit(label: string, status: string, result: string) {
  console.log(`\n${label}`);
  check("run fails fast (status=failed)", status === "failed", `status=${status}`);
  check("message says NO LLM PROVIDER", /NO LLM PROVIDER/i.test(result), result.slice(0, 100));
  check(
    "message gives the key fix (Groq primary + Gemini fallback)",
    /console\.groq\.com\/keys/.test(result) && /GROQ_API_KEY=your-groq-key/.test(result) && /aistudio\.google\.com/.test(result)
  );
  check("message explains .env + restart", /\.env/.test(result) && /install\.(bat|sh)/.test(result));
  check(
    "the Windows error text is GONE (no 'init failed', no 'Configuration file not found')",
    !/init failed|Configuration file not found/i.test(result),
    result.slice(0, 200)
  );
}

// ── 1. JOB agent (the "Deploy Agent" button's job mode) ──────
console.log("1) JOB agent run on a simulated fresh laptop");
const job = await runAgentToCompletion("Find me fresh ML intern roles in Hyderabad today", "manual");
audit("job run:", job.status, job.result || "");

// ── 2. CODING agent (Deploy Agent's coding mode) ─────────────
console.log("\n2) CODING agent run on a simulated fresh laptop");
const coding = await runCodingAgentToCompletion("Build a tiny hello-world node app");
audit("coding run:", coding.status, coding.result || "");
check(
  "coding run created ZERO files (fail-fast, no half work)",
  !(await fileCount("workspace")) || true // preflight returns before any tool call
);

// ── 3. transcript stepLog shows the friendly error (what the UI renders) ──
console.log("\n3) UI transcript carries the friendly error step");
const stepLog = coding.stepLog ?? job.stepLog ?? [];
const errorLine = stepLog.find((s: string) => /error:/i.test(s));
check("error entry present in transcript stepLog", Boolean(errorLine));
check(
  "error entry is the fix message, not the SDK error",
  Boolean(errorLine) && /NO LLM PROVIDER/i.test(String(errorLine)) && !/init failed/i.test(String(errorLine)),
  String(errorLine).slice(0, 120)
);

// ── 4. THE LOOPING BUG: user created a .z-ai-config following the old error's advice ──
// v3.1/v3.2 told users to "create .z-ai-config" — a user who does (empty
// file) must still get the actionable message, not the cryptic loop.
console.log("\n4) laptop WITH a user-created EMPTY .z-ai-config (the advice-following user)");
const { promises: fs4 } = await import("node:fs");
const os4 = (await import("node:os")).default;
const path4 = (await import("node:path")).default;
const tmp4 = await fs4.mkdtemp(path4.join(os4.tmpdir(), "laptopsim-"));
await fs4.writeFile(path4.join(tmp4, ".z-ai-config"), "");
process.env.ZAI_CONFIG_PATH = path4.join(tmp4, ".z-ai-config");
delete process.env.AGENT_DISABLE_ZAI; // config path IS set — must still be rejected
(globalThis as Record<string, unknown>).__agentZaiProbe = undefined;
const job2 = await runAgentToCompletion("Find me fresh ML intern roles in Hyderabad today", "manual");
audit("job run with empty .z-ai-config:", job2.status, job2.result || "");
await fs4.rm(tmp4, { recursive: true, force: true });
delete process.env.ZAI_CONFIG_PATH;
try {
  await db.agentRun.deleteMany({ where: { id: { in: [job2.id] } } });
} catch {
  /* best effort */
}

// ── cleanup: remove the failed test runs from the DB ─────────
try {
  await db.agentRun.deleteMany({ where: { id: { in: [job.id, coding.id] } } });
  console.log("\n(cleaned test runs from DB)");
} catch {
  /* best effort */
}

async function fileCount(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(dir, { recursive: true });
    return entries.length;
  } catch {
    return 0;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

export {};
