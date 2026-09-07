// GET /api/workspace/file?path=<rel>       → metadata + text content for the viewer
// GET /api/workspace/file?path=<rel>&raw=1 → raw bytes with proper mime
//     &inline=1 → Content-Disposition inline (used for image previews)
//
// Every path is sandboxed inside the workspace (absolute paths,
// ../ escapes and symlink escapes are all rejected with 400).

import { NextResponse } from "next/server";
import { WorkspaceApiError, readWorkspaceFile, serveRawFile } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rel = url.searchParams.get("path") ?? "";
  const raw = url.searchParams.get("raw") === "1";
  const inline = url.searchParams.get("inline") === "1";

  try {
    if (raw) {
      const { buffer, mime, name } = await serveRawFile(rel);
      const disposition = inline ? "inline" : "attachment";
      return new Response(new Uint8Array(buffer), {
        headers: {
          "content-type": mime,
          "content-length": String(buffer.length),
          "content-disposition": `${disposition}; filename="${name.replace(/["\\\r\n]/g, "_")}"`,
          "cache-control": "no-store",
        },
      });
    }
    const file = await readWorkspaceFile(rel);
    return NextResponse.json(file, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const status = e instanceof WorkspaceApiError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
