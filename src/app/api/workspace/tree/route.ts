// GET /api/workspace/tree — the full workspace listing for the
// VS Code-style explorer. Folders first, node_modules/.git/
// .agent-shell hidden, sizes + mtimes for every node (the UI uses
// mtime to badge files created during the CURRENT agent run).

import { NextResponse } from "next/server";
import { buildWorkspaceTree } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const meta = await buildWorkspaceTree();
    return NextResponse.json(meta);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
