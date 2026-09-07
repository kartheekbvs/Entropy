import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isAgentBusy, activeRunId, requestStop, startAgentRun } from "@/lib/agent/runner";
import { startCodingAgentRun } from "@/lib/agent/coding-runner";

export const maxDuration = 60;

// POST /api/agent/run — start an autonomous run with a natural-language goal
// body: { goal, mode?: "manual"|"autopilot", kind?: "job"|"coding" }
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { goal?: string; mode?: string; kind?: string };
    const goal = (body.goal ?? "").toString().trim();
    if (goal.length < 10 || goal.length > 2000) {
      return NextResponse.json(
        { error: "Goal must be 10–2000 characters. Describe what the agent should accomplish." },
        { status: 400 }
      );
    }
    if (isAgentBusy()) {
      return NextResponse.json(
        { error: "An agent run is already in progress. Wait for it to finish or stop it first.", activeRunId: activeRunId() },
        { status: 409 }
      );
    }
    const mode = body.mode === "autopilot" ? "autopilot" : "manual";
    const kind = body.kind === "coding" ? "coding" : "job";
    const id = kind === "coding" ? await startCodingAgentRun(goal, mode) : await startAgentRun(goal, mode);
    const run = await db.agentRun.findUnique({ where: { id } });
    return NextResponse.json({ run, kind }, { status: 201 });
  } catch (error) {
    console.error("POST /api/agent/run failed:", error);
    return NextResponse.json({ error: "Could not start the agent run." }, { status: 500 });
  }
}

// GET /api/agent/run?id=… — poll one run (live transcript) · no id → active/latest
export async function GET(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get("id") ?? activeRunId();
    if (id) {
      const run = await db.agentRun.findUnique({ where: { id } });
      if (run) return NextResponse.json({ run, busy: isAgentBusy() });
    }
    const latest = await db.agentRun.findFirst({ orderBy: { startedAt: "desc" } });
    return NextResponse.json({ run: latest ?? null, busy: isAgentBusy() });
  } catch (error) {
    console.error("GET /api/agent/run failed:", error);
    return NextResponse.json({ error: "Could not read agent run." }, { status: 500 });
  }
}

// DELETE /api/agent/run?id=… — request a graceful stop of the active run
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? activeRunId();
  if (!id || !isAgentBusy()) {
    return NextResponse.json({ error: "No active run to stop." }, { status: 400 });
  }
  if (id !== activeRunId()) {
    return NextResponse.json({ error: "That run is not active." }, { status: 400 });
  }
  return NextResponse.json({ stopped: requestStop() });
}
