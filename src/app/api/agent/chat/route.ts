import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { continueCodingRun, hasConversationSnapshot } from "@/lib/agent/coding-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────
// POST /api/agent/chat — v4.2 CHAT-CONTINUE (Copilot-Chat style).
//
// "after some execution we can chat to continuing the project for
// changes": after a coding run completes, the user sends follow-up
// messages here. The completed run's conversation snapshot (full
// history + written-file ledger) is restored, the follow-up is
// appended with a live workspace-tree refresh, and the agent loop
// re-enters with the same tools, sandbox and failover chain —
// streaming to the same run channel + xterm console as always.
//
// body: { message: string, runId?: string }
//       runId omitted → continue the LATEST completed project.
// GET  → is a chat-continuable project available? (UI hint)
// ─────────────────────────────────────────────────────────────

export async function GET() {
  try {
    const available = await hasConversationSnapshot();
    let latest: { id: string; goal: string; finishedAt: Date | null } | null = null;
    if (available) {
      latest = await db.agentRun.findFirst({
        where: { mode: "coding", status: "completed" },
        orderBy: { startedAt: "desc" },
        select: { id: true, goal: true, finishedAt: true },
      });
    }
    return NextResponse.json({ available, latest });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { message?: string; runId?: string };
    const message = (body.message ?? "").toString().trim();
    if (message.length < 3 || message.length > 2000) {
      return NextResponse.json(
        { error: "Follow-up message must be 3–2000 characters. Describe the change you want." },
        { status: 400 }
      );
    }
    const runId = body.runId?.toString().trim() || undefined;
    const out = await continueCodingRun(message, runId);
    if (!out.ok) {
      return NextResponse.json({ error: out.message }, { status: 409 });
    }
    const run = out.runId ? await db.agentRun.findUnique({ where: { id: out.runId } }) : null;
    return NextResponse.json({ ok: true, message: out.message, run }, { status: 201 });
  } catch (error) {
    console.error("POST /api/agent/chat failed:", error);
    return NextResponse.json({ error: "Could not continue the project chat." }, { status: 500 });
  }
}
