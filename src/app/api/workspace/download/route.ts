// GET /api/workspace/download — the whole agent workspace as a
// DEFLATE zip (node_modules, .git and .agent-shell excluded).
// This is the artifact you can hand to any other AI model or open
// in any editor/IDE. Filename is stamped: workspace-<date>.zip.

import { NextResponse } from "next/server";
import { WorkspaceApiError, buildWorkspaceZip } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { buffer, fileCount } = await buildWorkspaceZip();
    const stamp = new Date().toISOString().slice(0, 10); // 2026-09-06
    const name = `workspace-${stamp}.zip`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(buffer.length),
        "content-disposition": `attachment; filename="${name}"`,
        "x-file-count": String(fileCount),
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const status = e instanceof WorkspaceApiError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
