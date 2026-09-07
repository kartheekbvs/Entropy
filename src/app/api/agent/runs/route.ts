import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAgentBusy, activeRunId } from "@/lib/agent/runner";
import { isCodingAgentBusy, hasCheckpoint } from "@/lib/agent/coding-runner";

// GET /api/agent/runs?limit=20 — run history (meta only, no full transcripts)
// v3.7: a row that says "running" but is NOT the busy run of THIS process
// is a run orphaned by a crash / restart — it is re-labeled "interrupted"
// (deterministic, DB-side) so the UI can offer RESUME. Coding runs also
// report whether a disk checkpoint (resume memory) exists.
export async function GET(req: NextRequest) {
  try {
    const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "20", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;

    // One agent at a time → any OTHER "running" row is orphaned.
    const busyId = isAgentBusy() || isCodingAgentBusy() ? activeRunId() : null;
    const orphans = await db.agentRun.findMany({
      where: { status: "running", ...(busyId ? { id: { not: busyId } } : {}) },
      select: { id: true },
    });
    for (const o of orphans) {
      await db.agentRun
        .update({
          where: { id: o.id },
          data: {
            status: "interrupted",
            result: "Run was interrupted (server restart or crash) — press RESUME to continue it from the disk checkpoint with full memory.",
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined);
    }

    const runs = await db.agentRun.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
      select: {
        id: true,
        goal: true,
        mode: true,
        status: true,
        provider: true,
        stepCount: true,
        tokensUsed: true,
        startedAt: true,
        finishedAt: true,
        result: true,
      },
    });

    const resumable: Record<string, boolean> = {};
    for (const r of runs) {
      if (r.mode === "coding" && r.status !== "running") {
        resumable[r.id] = await hasCheckpoint(r.id);
      }
    }

    return NextResponse.json({
      runs: runs.map((r) => ({
        ...r,
        resultPreview: r.result?.slice(0, 220) ?? null,
        result: undefined,
        resumable: resumable[r.id] ?? false,
      })),
    });
  } catch (error) {
    console.error("GET /api/agent/runs failed:", error);
    return NextResponse.json({ error: "Could not read run history." }, { status: 500 });
  }
}
