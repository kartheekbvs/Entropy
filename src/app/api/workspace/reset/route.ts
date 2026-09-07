import { NextRequest, NextResponse } from "next/server";
import { resetWorkspace } from "@/lib/workspace";
import { terminalLine } from "@/lib/agent/event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────
// POST /api/workspace/reset — v4.0 "NEW PROJECT".
//
// The user's rule: after one project the old files have to GO when a
// new project starts. body: { archive?: boolean } — default true:
// every visible workspace entry moves to workspace/.archive/<stamp>/
// (hidden from the explorer and the zip, recoverable on disk), run
// checkpoints are retired and a fresh AGENT.md is written. archive:
// false deletes for real.
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { archive?: unknown };
    const archive = typeof body.archive === "boolean" ? body.archive : true;
    const result = await resetWorkspace({ archive });
    terminalLine(
      "sys",
      `workspace reset — ${result.itemsCleared} entries cleared${result.archivedTo ? `, archived to .archive/${result.archivedTo}` : " (deleted)"} · fresh AGENT.md written`
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
