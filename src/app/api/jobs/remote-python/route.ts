import { NextRequest, NextResponse } from "next/server";
import {
  collectRemotePythonRoles,
  type RemoteRole,
  type RemotePythonResult,
} from "@/lib/jobs/remote-python";
import { rankRemoteRolesWithAI, applyVerdicts, buildAiChain } from "@/lib/jobs/remote-python-llm";

/**
 * GET /api/jobs/remote-python
 *   ?limit=10   — max roles to return (1–25, default 10)
 *   ?refresh=1  — bypass the 10-minute board cache
 *   ?ai=0       — skip AI ranking (heuristics only)
 *
 * Finds ACTIVE open-anywhere remote Python developer roles suitable for a
 * fresher, ranked, with verified board links. Never returns 500 — board or
 * LLM failures degrade gracefully and are reported in `meta`/`ai.notes`.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // new URL() works for NextRequest AND plain Request (test harnesses)
  const url = req.nextUrl ?? new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit")) || 10, 25));
  const refresh = url.searchParams.get("refresh") === "1";
  const aiEnabled = url.searchParams.get("ai") !== "0";

  try {
    const pipeline = await collectRemotePythonRoles({ limit, refresh });
    let roles: RemoteRole[] = pipeline.roles;
    let ai;
    if (aiEnabled) {
      const ranked = await rankRemoteRolesWithAI(roles, {});
      roles = applyVerdicts(roles, ranked);
      ai = {
        provider: ranked.provider,
        model: ranked.model,
        summary: ranked.summary,
        degraded: ranked.degraded,
        notes: ranked.notes,
        verdictCount: ranked.verdicts.length,
      };
    } else {
      ai = { provider: "heuristic", model: "none", summary: "", degraded: true, notes: ["ai=0"], verdictCount: 0 };
    }

    const body: RemotePythonResult & { ok: true; ai: typeof ai } = {
      ...pipeline,
      roles,
      ok: true,
      ai,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    // unreachable in practice (pipeline never throws), kept as a hard guard
    return NextResponse.json(
      {
        ok: false,
        roles: [],
        boards: [],
        meta: null,
        error: e instanceof Error ? e.message.slice(0, 200) : "unknown pipeline error",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/** small helper for the UI's provider-trace chip */
export function aiChainPreview(): string[] {
  return buildAiChain().map((s) => `${s.provider}(${s.models.length})`);
}
