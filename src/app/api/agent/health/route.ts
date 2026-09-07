import { NextResponse } from "next/server";
import { getProviderHealth } from "@/lib/agent/llm";
import { probeNetwork } from "@/lib/agent/offline";
import { WORKSPACE_ROOT, getShellInfo } from "@/lib/agent/coding-tools";
import { rateLimitStatus } from "@/lib/agent/rate-limit";
import { llmResilienceStatus } from "@/lib/agent/llm-resilience";
import { budgetStatusAll } from "@/lib/agent/llm-budget";
import { promises as fs } from "node:fs";
import os from "node:os";

export const dynamic = "force-dynamic";

// GET /api/agent/health — agent preflight: which LLM providers are
// configured, where the coding workspace lives, which shell dialect
// the agent will use, and the machine's real resources. Powers the
// AgentView preflight card, the installer self-check and the MCP
// agent_health tool. Non-throwing by design.
export async function GET() {
  try {
    const health = await getProviderHealth();
    const shell = await getShellInfo();
    // v5.2 — 1.5s reachability probe (cached 30s): lets the launchers and
    // the preflight card say "OFFLINE — local engine armed" instead of
    // letting the user discover it through provider timeouts.
    const networkOnline = await probeNetwork();

    let workspaceExists = true;
    let workspaceFiles = 0;
    try {
      await fs.access(WORKSPACE_ROOT);
      const walk = async (d: string): Promise<number> => {
        let n = 0;
        const entries = await fs.readdir(d, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === ".agent-shell") continue;
          if (e.isDirectory()) n += await walk(d + "/" + e.name);
          else n++;
        }
        return n;
      };
      workspaceFiles = await walk(WORKSPACE_ROOT);
    } catch {
      workspaceExists = false;
    }

    return NextResponse.json({
      ok: health.anyConfigured,
      agent: {
        providersReady: health.anyConfigured,
        mode: health.mode,
        active: health.active,
        providers: health.providers,
        // v5.2 — network reachability + offline-engine state
        networkOnline,
      },
      workspace: {
        root: WORKSPACE_ROOT,
        exists: workspaceExists,
        files: workspaceFiles,
      },
      shell: {
        kind: shell.kind,
        label: shell.label,
      },
      system: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpuCores: os.cpus().length,
        totalMemoryMB: Math.round(os.totalmem() / 1048576),
        freeMemoryMB: Math.round(os.freemem() / 1048576),
        nodeVersion: process.versions.node,
      },
      rateLimits: rateLimitStatus(),
      // v4.1 — live request-queue / backoff / circuit-breaker state.
      llmQueue: llmResilienceStatus(),
      // v4.2 — daily request budgets per provider/free-model (the
      // "auto-takeover after 400" fallback server status).
      llmBudget: await budgetStatusAll(),
    });
  } catch (error) {
    console.error("GET /api/agent/health failed:", error);
    return NextResponse.json({ ok: false, error: "Health check failed." }, { status: 500 });
  }
}
