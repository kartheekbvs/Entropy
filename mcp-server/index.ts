#!/usr/bin/env bun
// ─────────────────────────────────────────────────────────────
// Job Command Center — MCP Server v3
//
// ONE unified Model Context Protocol server exposing BOTH agent
// superpowers to any MCP client (Claude Code, Claude Desktop,
// Cursor, VS Code MCP, z-ai):
//
//   • JOB-HUNT tools  — profile, 21 live public job sources,
//     JD scoring, tracker, contacts, board deep links, AI writing
//   • CODING tools    — workspace-sandboxed fs_read / fs_write /
//     fs_mkdir / fs_list / fs_search / fs_delete / shell_run
//     (Claude-Code-style, uses the host's real CPU/RAM)
//   • AGENT GOALS     — run_agent_goal (job loop), run_coding_goal
//     (full autonomous build loop) and agent_resume (v3.7: continue
//     a crashed/interrupted run from its disk checkpoint with the
//     full conversation memory restored)
//   • RESOURCES       — the workspace file tree as MCP resources
//     (VS-Code-style file access)
//   • GUARDRAILS      — per-request rate limiting + a JSON-lines
//     audit log of every tool call (workspace/.agent-shell/)
//
// Client config (Claude Code / .mcp.json):
//   {
//     "mcpServers": {
//       "job-command-center": {
//         "command": "bun",
//         "args": ["mcp-server/index.ts"]
//       }
//     }
//   }
//
// Run manually:  bun run mcp
// Env: DATABASE_URL, GEMINI_API_KEY, GEMINI_MODEL, OPENAI_API_KEY,
//      AGENT_LLM_PROVIDER, AGENT_WORKSPACE, AGENT_RATE_MCP, ...
//
// NOTE: stdout is the JSON-RPC channel — logs go to stderr only.
// ─────────────────────────────────────────────────────────────

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "node:fs";
import path from "node:path";

// ── stdout hygiene (MUST run before any app imports) ─────────
process.env.MCP_MODE = "1";
console.log = (...a: unknown[]) => console.error("[mcp]", ...a);

// Dynamic imports so MCP_MODE is set before modules initialize
const { AGENT_TOOLS, executeTool } = await import("../src/lib/agent/tools");
const { runAgentToCompletion, isAgentBusy } = await import("../src/lib/agent/runner");
const { CODING_TOOLS, executeCodingTool, WORKSPACE_ROOT, getShellInfo } = await import("../src/lib/agent/coding-tools");
const { runCodingAgentToCompletion, resumeCodingAgentRun, continueCodingRun } = await import("../src/lib/agent/coding-runner");
const { db } = await import("../src/lib/db");
const { SOURCE_COUNT } = await import("../src/lib/agent/jobs-api");
const { rateLimit } = await import("../src/lib/agent/rate-limit");
const { getProviderHealth, openrouterFreeModels, explabsModels } = await import("../src/lib/agent/llm");
const { budgetStatusAll, resetBudgets } = await import("../src/lib/agent/llm-budget");

const SERVER_NAME = "job-command-center";
const SERVER_VERSION = "3.0.0";

// ── Audit log (JSON lines) ───────────────────────────────────
const AUDIT_DIR = path.join(WORKSPACE_ROOT, ".agent-shell");
const AUDIT_FILE = path.join(AUDIT_DIR, "mcp-audit.log");

async function audit(tool: string, detail: Record<string, unknown>, ok: boolean): Promise<void> {
  try {
    await fs.mkdir(AUDIT_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), tool, ok, ...detail }) + "\n";
    await fs.appendFile(AUDIT_FILE, line, "utf8");
  } catch {
    /* audit is best-effort; never break a tool call */
  }
}

// ── Agent-goal tools ─────────────────────────────────────────
const RUN_AGENT_GOAL = {
  name: "run_agent_goal",
  description:
    "Run the FULL autonomous JOB-HUNT agent loop (Gemini native function calling, OpenAI/z-ai fallback) on a natural-language goal. The agent plans and executes by itself: searches live job sources, scores matches, writes to the tracker DB, and returns its final markdown report. Use for multi-step goals like 'find fresh ML internships and add the top 5 to my tracker'.",
};

const RUN_CODING_GOAL = {
  name: "run_coding_goal",
  description:
    "Run the FULL autonomous CODING agent (Claude-Code-style) on a build goal. It creates folders, writes complete files, edits surgically, runs shell commands, starts servers, verifies with curl, and iterates until the app WORKS — all inside the workspace sandbox. Example: 'build a portfolio website with a Node server on port 4599 and verify it responds'. Takes minutes; returns the full report (file tree, run instructions, verification evidence).",
};

const AGENT_HEALTH = {
  name: "agent_health",
  description:
    "Preflight check for the agent stack: which LLM providers are configured (Gemini / OpenAI / z-ai) with actionable setup hints, the coding workspace location and file count, the shell dialect (bash or cmd), and the host's real CPU/RAM. Call this FIRST when the agent misbehaves or before starting long builds — it explains exactly what is ready and what is missing on THIS machine.",
};

const AGENT_RESUME = {
  name: "agent_resume",
  description:
    "v3.7 iron-man resume: continue a crashed / interrupted / LLM-dead coding run from its disk checkpoint. The FULL conversation memory (plan, files written so far, rounds done) is restored and the next healthy provider continues coding exactly where the dead model stopped — workspace files are never touched. Pass the runId from run_coding_goal output or the dashboard's Run History. Waits for the resumed run to finish and returns its final report.",
};

// ── v4.2 — the budget/auto-takeover server + chat-continue, MCP-exposed ──
const AGENT_BUDGET = {
  name: "agent_budget",
  description:
    "v4.2 fallback-server status: per-provider (and per free-model) DAILY request budgets — usage, limit, time-to-reset (UTC midnight), and which provider would auto-take-over when one is exhausted (default 400/day; the free-model relay rotates poolside → nemotron-lightning → dots3 automatically). Pass reset:true to zero all counters (admin). This is the mechanism that guarantees the task always completes even after a provider's daily budget is spent.",
};

const AGENT_CHAT = {
  name: "agent_chat",
  description:
    "v4.2 Copilot-Chat-style follow-up: continue the LAST completed coding project with a change request ('add a dark-mode toggle', 'fix the upload bug'). The full conversation memory + written-file ledger are restored, your message is appended with a live workspace-tree refresh, and the agent re-enters the loop (same tools, sandbox, failover chain). Waits for the continued run to finish and returns its report.",
};

// ── Server ───────────────────────────────────────────────────
const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {} } }
);

// ── tools/list ───────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
    ...CODING_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
    })),
    {
      name: RUN_AGENT_GOAL.name,
      description: RUN_AGENT_GOAL.description,
      inputSchema: {
        type: "object" as const,
        properties: {
          goal: {
            type: "string",
            description: "Natural-language job-hunt goal, e.g. 'Search live ML/AI internships in India, score them, add the best 5 to my tracker with reasoning'",
          },
        },
        required: ["goal"],
      },
    },
    {
      name: RUN_CODING_GOAL.name,
      description: RUN_CODING_GOAL.description,
      inputSchema: {
        type: "object" as const,
        properties: {
          goal: {
            type: "string",
            description: "Natural-language build goal, e.g. 'Build a Python CLI todo app with tests and run them'",
          },
        },
        required: ["goal"],
      },
    },
    {
      name: AGENT_HEALTH.name,
      description: AGENT_HEALTH.description,
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: AGENT_RESUME.name,
      description: AGENT_RESUME.description,
      inputSchema: {
        type: "object" as const,
        properties: {
          runId: {
            type: "string",
            description: "The id of the coding run to resume (from run_coding_goal output or the dashboard Run History)",
          },
        },
        required: ["runId"],
      },
    },
    {
      name: AGENT_BUDGET.name,
      description: AGENT_BUDGET.description,
      inputSchema: {
        type: "object" as const,
        properties: {
          reset: {
            type: "boolean",
            description: "Reset all daily budget counters to zero (admin action — the chain will use every provider again immediately)",
          },
        },
      },
    },
    {
      name: AGENT_CHAT.name,
      description: AGENT_CHAT.description,
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The follow-up change request for the last completed coding project, e.g. 'add a dark-mode toggle and verify the server still responds'",
          },
        },
        required: ["message"],
      },
    },
  ],
}));

// ── tools/call (rate-limited + audited) ──────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  const rl = rateLimit("mcp");
  if (!rl.allowed) {
    await audit(name, { rateLimited: true, retryAfterMs: rl.retryAfterMs }, false);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `MCP rate limit — retry in ${rl.retryAfterMs}ms` }),
        },
      ],
      isError: true,
    };
  }

  const argKeys = args && typeof args === "object" ? Object.keys(args) : [];
  console.error(`[mcp] tools/call ${name} (${argKeys.join(", ") || "no args"})`);

  try {
    // Health check (never rate-limited into silence — it's the diagnostic tool)
    if (name === AGENT_HEALTH.name) {
      const providerHealth = await getProviderHealth();
      const shell = await getShellInfo();
      let workspaceExists = true;
      try {
        await fs.access(WORKSPACE_ROOT);
      } catch {
        workspaceExists = false;
      }
      const out = {
        ...providerHealth,
        workspace: { root: WORKSPACE_ROOT, exists: workspaceExists },
        shell: { kind: shell.kind, label: shell.label },
        mcpServer: `${SERVER_NAME} v${SERVER_VERSION}`,
      };
      await audit(name, { anyConfigured: providerHealth.anyConfigured }, true);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    // v3.7 agent_resume — restore a dead run's memory and let the next
    // healthy provider finish it; waits for the resumed run to complete.
    if (name === AGENT_RESUME.name) {
      const runId = String((args ?? {}).runId ?? "").trim();
      if (!runId) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "runId is required" }) }],
          isError: true,
        };
      }
      const started = await resumeCodingAgentRun(runId);
      if (!started.ok || !started.runId) {
        await audit(name, { runId, ok: false }, false);
        return { content: [{ type: "text", text: JSON.stringify(started, null, 2) }], isError: true };
      }
      const deadline = Date.now() + 100 * 60 * 1000; // matches the marathon budget
      let row = await db.agentRun.findUnique({ where: { id: started.runId } });
      while (row?.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        row = await db.agentRun.findUnique({ where: { id: started.runId! } });
      }
      const out = {
        ...started,
        finalStatus: row?.status ?? "unknown",
        steps: row?.stepCount ?? 0,
        tokens: row?.tokensUsed ?? 0,
        provider: row?.provider ?? "",
        report: row?.result ?? "",
      };
      await audit(name, { runId, newRunId: started.runId, status: out.finalStatus }, true);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    // v4.2 agent_budget — the daily-budget auto-takeover server status.
    if (name === AGENT_BUDGET.name) {
      const reset = Boolean((args ?? {}).reset);
      if (reset) resetBudgets();
      const status = await budgetStatusAll();
      const out = {
        freechainModels: openrouterFreeModels(),
        explabsModels: explabsModels(),
        defaultProviderLimit: Number(process.env.AGENT_PROVIDER_DAILY_BUDGET ?? 400),
        freeModelLimit: Number(process.env.AGENT_FREECHAIN_DAILY_BUDGET ?? 50),
        budgets: status,
        reset,
        note:
          "When a budget is exhausted the provider chain auto-takes-over with the next provider (memory preserved); counters reset at UTC midnight. Free-chain and Experiential Labs models are budgeted per model (explabs:<slug>).",
      };
      await audit(name, { reset, keys: Object.keys(status).length }, true);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    // v4.2 agent_chat — Copilot-Chat-style follow-up on the last project.
    if (name === AGENT_CHAT.name) {
      const message = String((args ?? {}).message ?? "").trim();
      if (!message) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "message is required" }) }],
          isError: true,
        };
      }
      const started = await continueCodingRun(message);
      if (!started.ok || !started.runId) {
        await audit(name, { ok: false }, false);
        return { content: [{ type: "text", text: JSON.stringify(started, null, 2) }], isError: true };
      }
      const deadline = Date.now() + 100 * 60 * 1000;
      let row = await db.agentRun.findUnique({ where: { id: started.runId } });
      while (row?.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        row = await db.agentRun.findUnique({ where: { id: started.runId! } });
      }
      const out = {
        ...started,
        finalStatus: row?.status ?? "unknown",
        steps: row?.stepCount ?? 0,
        tokens: row?.tokensUsed ?? 0,
        provider: row?.provider ?? "",
        report: row?.result ?? "",
      };
      await audit(name, { message: message.slice(0, 200), status: out.finalStatus }, true);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    // Agent-goal tools
    if (name === RUN_AGENT_GOAL.name || name === RUN_CODING_GOAL.name) {
      const goal = String((args ?? {}).goal ?? "").trim();
      if (!goal) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "goal is required" }) }],
          isError: true,
        };
      }
      if (isAgentBusy()) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "another agent run is already active in this process" }),
            },
          ],
          isError: true,
        };
      }
      const out =
        name === RUN_AGENT_GOAL.name
          ? await runAgentToCompletion(goal, "manual")
          : await runCodingAgentToCompletion(goal);
      await audit(name, { goal: goal.slice(0, 200), status: out.status, steps: out.stepLog.length }, true);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }

    // Job tools
    const jobTool = AGENT_TOOLS.find((t) => t.name === name);
    if (jobTool) {
      const result = await executeTool(name, args ?? {});
      await audit(name, { args: argKeys, ok: !resultHasError(result) }, !resultHasError(result));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: resultHasError(result),
      };
    }

    // Coding tools
    const codingTool = CODING_TOOLS.find((t) => t.name === name);
    if (codingTool) {
      const result = await executeCodingTool(name, args ?? {});
      await audit(name, { args: argKeys, ok: !resultHasError(result) }, !resultHasError(result));
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: resultHasError(result),
      };
    }

    await audit(name, { error: "unknown tool" }, false);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
      isError: true,
    };
  } catch (e) {
    await audit(name, { error: (e as Error).message }, false);
    return {
      content: [{ type: "text", text: `tool ${name} failed: ${(e as Error).message}` }],
      isError: true,
    };
  }
});

function resultHasError(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && "error" in (result as Record<string, unknown>));
}

// ── resources/list — workspace files (VS-Code-style) ─────────
const TEXT_EXT = new Set([
  ".txt", ".md", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css",
  ".py", ".csv", ".yml", ".yaml", ".xml", ".sh", ".env", ".sql", ".toml", ".ini", ".log",
]);

async function walkWorkspace(dir: string, base: string, out: Array<{ uri: string; name: string; mimeType: string; size: number }>, cap = 300): Promise<void> {
  if (out.length >= cap) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full);
    if (e.isDirectory()) {
      if (["node_modules", ".git"].includes(e.name)) continue;
      await walkWorkspace(full, base, out, cap);
    } else if (e.isFile() && TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      let size = 0;
      try {
        size = (await fs.stat(full)).size;
      } catch {
        /* skip */
      }
      out.push({ uri: `workspace://${rel}`, name: rel, mimeType: "text/plain", size });
    }
  }
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const out: Array<{ uri: string; name: string; mimeType: string; size: number }> = [];
  await walkWorkspace(WORKSPACE_ROOT, WORKSPACE_ROOT, out);
  return { resources: out };
});

// ── resources/read ───────────────────────────────────────────
server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = String(req.params.uri ?? "");
  if (!uri.startsWith("workspace://")) {
    throw new Error(`unsupported resource uri: ${uri}`);
  }
  const rel = uri.slice("workspace://".length);
  const abs = path.resolve(WORKSPACE_ROOT, rel);
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error("resource path escapes the workspace sandbox");
  }
  try {
    const content = await fs.readFile(abs, "utf8");
    return { contents: [{ uri, mimeType: "text/plain", text: content.slice(0, 100_000) }] };
  } catch (e) {
    throw new Error(`cannot read resource ${uri}: ${(e as Error).message}`);
  }
});

// ── ping ─────────────────────────────────────────────────────
server.setRequestHandler(PingRequestSchema, async () => ({}));

// ── Boot ─────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[mcp] ${SERVER_NAME} v${SERVER_VERSION} online — ${AGENT_TOOLS.length + CODING_TOOLS.length + 6} tools (${AGENT_TOOLS.length} job · ${CODING_TOOLS.length} coding · 2 agent goals · health · resume · budget · chat) · ${SOURCE_COUNT} live job sources · workspace: ${WORKSPACE_ROOT} · provider: ${process.env.AGENT_LLM_PROVIDER || "auto"}`
);
console.error(`[mcp] audit log: ${AUDIT_FILE}`);
