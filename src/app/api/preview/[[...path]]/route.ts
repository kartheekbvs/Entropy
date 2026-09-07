// GET /api/preview/<anything-in-the-workspace>
//
// The Replit-style WEBVIEW backend. Every URL under /api/preview/
// maps 1:1 onto the agent's workspace:
//
//   /api/preview                        → root entry (redirects)
//   /api/preview/frontend/              → directory entry (redirects)
//   /api/preview/frontend/index.html    → HTML + injected live runtime
//   /api/preview/frontend/static/app.js → raw bytes, correct mime
//
// Served HTML gets the preview runtime injected (see lib/preview.ts):
// a <base> tag so the page's relative CSS/JS/images resolve inside
// the preview URL space, console forwarding, error capture, a
// storage polyfill for sandboxed frames, and the live-reload
// EventSource. Assets pass through byte-clean with proper mime.
//
// Sandbox mirrors the workspace API: lexical + realpath checks,
// absolute paths and ../ escapes rejected with 400.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  WorkspaceApiError,
  buildWorkspaceTree,
  getWorkspaceRoot,
  safeResolve,
  serveRawFile,
  type WorkspaceNode,
} from "@/lib/workspace";
import { injectPreviewRuntime, isPreviewableFile, bestPreviewEntry } from "@/lib/preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** HTML bigger than this is served raw (injection cost not worth it). */
const MAX_INJECT_BYTES = 2 * 1024 * 1024;

/** Friendly styled placeholder for empty/404 states (the new-tab view). */
function placeholderPage(title: string, body: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Live Preview</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:#0c0714;background-image:radial-gradient(60rem 40rem at 20% -10%,rgba(236,72,153,.18),transparent),
radial-gradient(50rem 30rem at 110% 110%,rgba(56,189,248,.12),transparent);color:#e2e8f0}
.card{max-width:34rem;margin:2rem;padding:2rem 2.25rem;border-radius:1rem;
background:rgba(24,14,36,.72);border:1px solid rgba(236,72,153,.25);box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 .5rem;font-size:1.15rem;letter-spacing:.02em;color:#f9a8d4}
p{margin:.4rem 0;line-height:1.6;font-size:.85rem;color:#a5b0c2}
code{font-family:ui-monospace,Consolas,monospace;font-size:.78rem;color:#fbbf24;background:rgba(251,191,36,.08);
padding:.1rem .35rem;border-radius:.35rem}
</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Find the entry HTML for a directory: index.html, else the freshest .html beneath it. */
async function entryForDir(abs: string, root: string): Promise<string | null> {
  const stats = async (p: string) => {
    try {
      return await fs.stat(p);
    } catch {
      return null;
    }
  };
  for (const name of ["index.html", "index.htm"]) {
    const cand = path.join(abs, name);
    const st = await stats(cand);
    if (st?.isFile()) return path.relative(root, cand).split(path.sep).join("/");
  }
  // freshest .html anywhere under this directory
  let best: { rel: string; mtime: number } | null = null;
  const queue = [abs];
  let guard = 0;
  while (queue.length > 0 && guard < 4000) {
    guard++;
    const dir = queue.shift() as string;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name === "node_modules" || d.name === ".git" || d.name === ".archive" || d.isSymbolicLink()) {
        continue;
      }
      const child = path.join(dir, d.name);
      if (d.isDirectory()) {
        queue.push(child);
      } else if (/\.html?$/i.test(d.name)) {
        const st = await stats(child);
        if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) {
          best = { rel: path.relative(root, child).split(path.sep).join("/"), mtime: st.mtimeMs };
        }
      }
    }
  }
  return best ? best.rel : null;
}

function flatFiles(nodes: WorkspaceNode[]): WorkspaceNode[] {
  const out: WorkspaceNode[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as WorkspaceNode;
    if (n.type === "file") out.push(n);
    else if (n.children) stack.push(...n.children);
  }
  return out;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  const { path: segs } = await params;
  const rel = (segs ?? []).join("/");
  const root = getWorkspaceRoot();

  // ── "/" (the webview root) → resolve the best entry ──
  if (rel === "") {
    const meta = await buildWorkspaceTree(root);
    const best = bestPreviewEntry(meta.tree);
    if (!best) {
      return placeholderPage(
        "No app to preview yet",
        `<p>The workspace has no HTML pages, so there is nothing to render.</p>
         <p>Give the agent a build goal — pages appear here the moment they
         are written, and the preview refreshes itself while the agent works.</p>`
      );
    }
    return NextResponse.redirect(new URL(`/api/preview/${best.path}`, req.url), 307);
  }

  let abs: string;
  try {
    abs = safeResolve(root, rel);
  } catch (e) {
    const status = e instanceof WorkspaceApiError ? e.status : 400;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    // requested file doesn't exist — honest empty state
    if (rel !== "" && !rel.endsWith("/")) {
      return placeholderPage(
        "Nothing here yet",
        `<p>The agent has not created <code>${rel.replace(/[<>&"]/g, "")}</code> yet.</p>
         <p>It will appear here — live — the moment the agent writes it.</p>`,
        404
      );
    }
    const meta = await buildWorkspaceTree(root);
    const files = flatFiles(meta.tree).filter((f) => isPreviewableFile(f.name));
    if (files.length === 0) {
      return placeholderPage(
        "No app to preview yet",
        `<p>The workspace has no HTML pages, so there is nothing to render.</p>
         <p>Give the agent a build goal — pages appear here the moment they
         are written, and the preview refreshes itself while the agent works.</p>`
      );
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return NextResponse.redirect(new URL(`/api/preview/${files[0].path}`, req.url), 307);
  }

  // ── directory → entry redirect ──
  if (st.isDirectory()) {
    const entry = await entryForDir(abs, root);
    if (entry) {
      return NextResponse.redirect(new URL(`/api/preview/${entry}`, req.url), 307);
    }
    return placeholderPage(
      "No page in this folder",
      `<p>This folder has no <code>index.html</code> and no HTML page beneath it.</p>`,
      404
    );
  }

  if (!st.isFile()) {
    return NextResponse.json({ error: `not a regular file: ${rel}` }, { status: 400 });
  }

  // ── HTML entry → served with the live runtime ──
  if (/\.html?$/i.test(path.basename(abs)) && st.size <= MAX_INJECT_BYTES) {
    try {
      const raw = await serveRawFile(rel, root);
      const html = raw.buffer.toString("utf8");
      return new Response(injectPreviewRuntime(html, rel), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (e) {
      const status = e instanceof WorkspaceApiError ? e.status : 500;
      return NextResponse.json({ error: (e as Error).message }, { status });
    }
  }

  // ── any other file → raw bytes with the right mime (asset passthrough) ──
  try {
    const { buffer, mime, name } = await serveRawFile(rel, root);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type": mime,
        "content-length": String(buffer.length),
        // inline so images/svg open in the tab instead of downloading;
        // classic asset loads ignore disposition either way
        "content-disposition": `inline; filename="${name.replace(/["\\\r\n]/g, "_")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    const status = e instanceof WorkspaceApiError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
