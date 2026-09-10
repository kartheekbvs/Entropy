// ─────────────────────────────────────────────────────────────
//  ENTROPY LOCAL ENGINE — the offline fallback provider (v5.2)
//
//  WHY THIS EXISTS: the cloud chain (explabs → openrouter → …)
//  needs keys AND internet. On a laptop offline / behind a
//  firewall / with quota burnt everywhere, the old chain spun
//  for its whole 120s deadline and then failed the run —
//  "lagging, failing, files are not creating". This engine
//  guarantees the agent ALWAYS answers and offline coding goals
//  ALWAYS produce real files on disk.
//
//  HOW IT WORKS:
//  • probeNetwork() — 1.5s reachability probe (cached 30s on
//    globalThis). When the network is down the chain skips
//    every cloud provider INSTANTLY — zero lag.
//  • offlineGenerate() — a deterministic, zero-dependency
//    "LLM" that speaks the same LlmResponse shape as the real
//    providers: it reads the conversation, classifies intent,
//    and answers with either plain text (chat/plan) or REAL
//    tool calls (fs_write / fs_batch) that the normal agent
//    runner executes — so offline runs create actual projects
//    in workspace/ exactly like online runs.
//  • It is wired as the LAST link of the auto chain and the
//    FIRST link when offline: the chain never dead-ends.
//
//  Wire it off with OFFLINE_ENGINE=0 in .env.
// ─────────────────────────────────────────────────────────────

import type { AgentToolCall, HistoryTurn, LlmResponse } from "./llm";
import type { ToolDef } from "./tools";

export const OFFLINE_ENGINE_VERSION = "1.0.0";
export const OFFLINE_PROVIDER_NAME = "offline" as const;

export function offlineEngineEnabled(): boolean {
  return process.env.OFFLINE_ENGINE !== "0";
}

// ── Network reachability probe (cached) ──────────────────────
// Cheap HEAD requests with a hard timeout. If none of the
// well-known endpoints answers, we treat the machine as OFFLINE
// and skip the whole cloud chain — one failed request instead
// of N × timeout-per-provider (the old "lagging" behavior).
//
// v5.4 — COLD-START HARDENING: the first probe in a fresh process
// can miss on slow first DNS/TLS (all 4 endpoints inside a tight
// 1.5s window). A false OFFLINE here skips the whole cloud chain
// for 30s (cached) — the flaky "instant offline" the user saw
// right after a restart. Fixes: (1) one immediate retry with a
// wider window, (2) negative results cache for only 5s so the
// next run re-probes instead of stewing offline, positive results
// still cache 30s.
const NET_PROBE_KEY = "__entropyNetProbe";
const NET_PROBE_TTL_MS = 30_000;
const NET_PROBE_TTL_DOWN_MS = 5_000;

type NetProbe = { at: number; up: boolean };
const g = globalThis as unknown as Record<string, unknown>;

async function probeOnce(timeoutMs: number): Promise<boolean> {
  const endpoints = [
    "https://api.groq.com",
    "https://api.experientiallabs.ai",
    "https://openrouter.ai",
    "https://www.google.com",
  ];
  let up = false;
  await Promise.race([
    Promise.all(
      endpoints.map((u) =>
        fetch(u, { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) })
          .then(() => {
            up = true;
          })
          .catch(() => undefined)
      )
    ),
    new Promise<void>((r) => setTimeout(r, timeoutMs + 500)),
  ]);
  return up;
}

export async function probeNetwork(): Promise<boolean> {
  const cached = g[NET_PROBE_KEY] as NetProbe | undefined;
  if (cached) {
    const ttl = cached.up ? NET_PROBE_TTL_MS : NET_PROBE_TTL_DOWN_MS;
    if (Date.now() - cached.at < ttl) return cached.up;
  }

  let up = await probeOnce(1500);
  if (!up) up = await probeOnce(4000); // cold DNS/TLS gets one wider retry
  g[NET_PROBE_KEY] = { at: Date.now(), up } satisfies NetProbe;
  return up;
}

// ── Intent classification ────────────────────────────────────
type Intent = "chat" | "coding" | "jobplan" | "question";

const CODING_RE =
  /\b(build|create|make|generate|scaffold|code|app|website|web page|site|landing|portfolio|game|dashboard|html|css|js|javascript|react|script|tool|api|clone)\b/i;
const JOB_RE =
  /\b(job|jobs|career|resume|cv|cover letter|interview|apply|application|recruiter|hiring|linkedin|naukri|internship|fresher|tracker)\b/i;
const GREETING_RE = /^(hi|hello|hey|yo|sup|hola|namaste|good (morning|afternoon|evening)|test|ping)\b/i;

function classify(text: string): Intent {
  if (GREETING_RE.test(text.trim()) && text.trim().length < 60) return "chat";
  if (CODING_RE.test(text)) return "coding";
  if (JOB_RE.test(text)) return "jobplan";
  if (text.trim().endsWith("?")) return "question";
  return "chat";
}

// Derive a filesystem-safe folder name from the goal.
function slugify(text: string): string {
  const words =
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4) ?? [];
  const base = words.join("-").slice(0, 32) || "offline-app";
  return `app-${base}`;
}

const ONLINE_HINT =
  "Online mode is even more powerful — add any free key (Groq: https://console.groq.com/keys) to .env and restart for full AI reasoning.";

/** Extract the human goal from the conversation (last user turn). */
function lastUserGoal(history: HistoryTurn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role === "user" && typeof t.text === "string" && t.text.trim()) {
      // strip tool-result wrappers some runners use
      const m = t.text.match(/^(?:GOAL|REQUEST):\s*(.+)$/i);
      return (m ? m[1] : t.text).trim().slice(0, 400);
    }
  }
  return "";
}

/** True when the runner has already executed our build plan once —
 *  the next engine turn must be the final report. Detection: the
 *  fs_write tool result echoes the file path, and every file the
 *  offline engine writes lives under an `app-…/` folder. */
function alreadyBuilt(history: HistoryTurn[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    // tool results arrive as { role: "toolResults", results: [{name, result}] }
    if (t.role === "toolResults") {
      const s = JSON.stringify((t as { results: Array<{ name: string; result: unknown }> }).results);
      if (s.includes("app-") || s.includes("entropy-offline-build")) return true;
    }
  }
  return false;
}

// ── Template: a complete, working, attractive static app ──────
// Generated deterministically from the goal. This is what gets
// written to disk offline — a REAL runnable site, not a stub.
function buildTemplateFiles(goal: string): Array<{ path: string; content: string }> {
  const title = goal.replace(/[<>]/g, "").slice(0, 70) || "Offline Build";
  const folder = slugify(goal);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="aurora"></div>
  <main>
    <h1>${title}</h1>
    <p class="tagline">Generated by the Entropy Local Engine — 100% offline, zero API calls.</p>
    <div class="card">
      <h2>What is this?</h2>
      <p>This page was scaffolded by the deterministic offline engine inside Entropy.
      Everything here runs from plain HTML + CSS + JS: open it in any browser,
      deploy it to GitHub Pages, or edit the files in <code>${folder}/</code>.</p>
    </div>
    <div class="card">
      <h2>Live demo</h2>
      <button id="go" class="btn">Click me</button>
      <span id="out" class="out">waiting…</span>
    </div>
  </main>
  <script src="script.js"></script>
</body>
</html>
`;
  const css = `/* ${title} — Entropy Local Engine template */
* { box-sizing: border-box; margin: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: oklch(0.17 0.035 152);
  color: oklch(0.92 0.03 142);
  min-height: 100vh;
  display: grid;
  place-items: center;
}
.aurora {
  position: fixed; inset: -20%;
  background:
    radial-gradient(40% 35% at 20% 25%, oklch(0.77 0.19 142 / 0.25), transparent 70%),
    radial-gradient(35% 30% at 80% 20%, oklch(0.72 0.15 95 / 0.18), transparent 70%),
    radial-gradient(45% 40% at 60% 85%, oklch(0.70 0.14 200 / 0.16), transparent 70%);
  pointer-events: none;
}
main { position: relative; max-width: 640px; padding: 2.5rem; display: grid; gap: 1.25rem; }
h1 {
  font-size: clamp(1.8rem, 5vw, 2.6rem);
  background: linear-gradient(135deg, #a9e46d, #71c84b, #f0c66a);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.tagline { color: oklch(0.81 0.03 142 / 0.8); }
.card {
  background: oklch(0.22 0.04 152 / 0.7);
  border: 1px solid oklch(0.75 0.16 142 / 0.35);
  border-radius: 14px; padding: 1.25rem 1.4rem; backdrop-filter: blur(8px);
}
.card h2 { color: #a9e46d; font-size: 1.02rem; margin-bottom: 0.5rem; }
.card p { line-height: 1.6; color: oklch(0.88 0.02 142); }
code { color: #f0c66a; }
.btn {
  margin-top: 0.5rem; cursor: pointer; border: 0; border-radius: 10px;
  padding: 0.65rem 1.3rem; font-weight: 700; color: oklch(0.2 0.03 152);
  background: linear-gradient(135deg, #a9e46d, #71c84b);
  box-shadow: 0 0 18px oklch(0.77 0.19 142 / 0.35);
}
.btn:hover { filter: brightness(1.08); }
.out { margin-left: 0.9rem; font-family: ui-monospace, monospace; color: #a9e46d; }
`;
  const js = `// ${title} — interactive demo logic
const btn = document.getElementById("go");
const out = document.getElementById("out");
let n = 0;
btn.addEventListener("click", () => {
  n += 1;
  out.textContent = \`clicked \${n}× — offline engine works\`;
});
`;
  const readme = `# ${title}

Built by the **Entropy Local Engine** (offline, deterministic, v${OFFLINE_ENGINE_VERSION}).

- \`index.html\` — page structure
- \`style.css\` — bright verdant theme
- \`script.js\` — interactivity

Run it: just open \`index.html\` in a browser (or serve the folder:
\`npx serve\` / \`python -m http.server\`).

Goal was: "${goal.replace(/"/g, "'")}"
`;
  return [
    { path: `${folder}/index.html`, content: html },
    { path: `${folder}/style.css`, content: css },
    { path: `${folder}/script.js`, content: js },
    { path: `${folder}/README.md`, content: readme },
  ];
}

// ── The engine itself ────────────────────────────────────────
// Speaks the exact LlmResponse contract the runners already
// consume: text for a final answer, toolCalls for real actions.
export async function offlineGenerate(
  history: HistoryTurn[],
  _tools: ToolDef[],
  _system: string
): Promise<LlmResponse> {
  const goal = lastUserGoal(history);

  // 1) If our build plan already executed → deliver the final report.
  if (alreadyBuilt(history)) {
    const folder = slugify(goal);
    return {
      text: `OFFLINE BUILD COMPLETE — ${folder}/

Created by the Entropy Local Engine with zero network calls:
- ${folder}/index.html — working page (open it in your browser)
- ${folder}/style.css — full bright theme
- ${folder}/script.js — interactive logic
- ${folder}/README.md — how to run it

The Live App Preview panel can render it now. ${ONLINE_HINT}`,
      tokens: 180,
      model: `entropy-local-engine v${OFFLINE_ENGINE_VERSION}`,
    };
  }

  // 2) Classify and respond.
  const intent = classify(goal);

  if (intent === "coding") {
    const files = buildTemplateFiles(goal);
    const toolCalls: AgentToolCall[] = files.map((f) => ({
      name: "fs_write",
      args: { path: f.path, content: f.content },
    }));
    return {
      text: undefined,
      toolCalls,
      tokens: 90,
      model: `entropy-local-engine v${OFFLINE_ENGINE_VERSION}`,
    };
  }

  if (intent === "jobplan") {
    return {
      text: `JOB PLAN (Entropy Local Engine — offline mode)

No API key / no network detected, so here is a structured offline plan for: "${goal}"

1. TARGET — pick 2 roles + 1 dream company today; save them in the Tracker.
2. APPLY — 5 focused applications/day: 2 Naukri, 2 LinkedIn, 1 referral ask.
3. DOCUMENTS — keep resume.pdf + one tailored cover letter per role family.
4. FOLLOW-UP — every application gets a follow-up message after 5 days (Contacts tab).
5. SKILL — 1 hour/day on the exact skill your top 3 job posts repeat.

${ONLINE_HINT}`,
      tokens: 150,
      model: `entropy-local-engine v${OFFLINE_ENGINE_VERSION}`,
    };
  }

  if (intent === "question") {
    return {
      text: `OFFLINE ANSWER (Entropy Local Engine)

I'm the local offline engine — deterministic, no API calls, always available.
You asked: "${goal}"

For full reasoning power over that question, connect any free key
(Groq is fastest: https://console.groq.com/keys → .env → restart).
Meanwhile the coding agent works fully offline: try
"build a portfolio website" and real files will appear in the workspace.`,
      tokens: 120,
      model: `entropy-local-engine v${OFFLINE_ENGINE_VERSION}`,
    };
  }

  // chat / greeting
  return {
    text: `Entropy Local Engine online (offline mode) ✓

The dashboard, tracker, contacts, JD match, workspace and file tools all work
without internet. Ask me to BUILD something — e.g. "build a portfolio site" —
and I'll create real files in workspace/ right now, fully offline.

${ONLINE_HINT}`,
    tokens: 100,
    model: `entropy-local-engine v${OFFLINE_ENGINE_VERSION}`,
  };
}
