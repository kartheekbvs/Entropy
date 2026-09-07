// GET /api/preview/stackblitz — the v4.8 StackBlitz Live App feed.
//
// Runs the README-reading analyzer against the REAL workspace and
// returns a ready-to-embed StackBlitz project: template, files,
// auto-run start script, warnings — everything the client SDK
// needs to boot the agent's app with dependencies installed.
//
//   GET /api/preview/stackblitz            → auto-detected project
//   GET /api/preview/stackblitz?root=app   → force a project root
//
// A whole-tree signature cache keeps this cheap: identical tree
// (path + size + mtime of every file) → cached analysis, so the
// 30 s poll / write-burst refetches never re-read 200 files.

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { buildWorkspaceTree, type WorkspaceNode } from "@/lib/workspace";
import { analyzeStackBlitzProject, computeSignature, type SBAnalysis, type SBTreeNode } from "@/lib/stackblitz-project";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" };

// ── cached analysis (whole-tree signature) ───────────────────

let cache: { sig: string; root: string | null; analysis: SBAnalysis } | null = null;

function flatten(nodes: WorkspaceNode[]): Array<{ path: string; size: number; mtime: number }> {
  const out: Array<{ path: string; size: number; mtime: number }> = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as WorkspaceNode;
    if (n.type === "file") out.push({ path: n.path, size: n.size, mtime: n.mtime });
    else if (n.children) stack.push(...n.children);
  }
  return out;
}

// ── text reader with binary sniffing (the analyzer's eyes) ───

const READER_MAX_BYTES = 256 * 1024;
const SNIFF_BYTES = 8192;

function looksBinary(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

async function makeReader(root: string) {
  return async (rel: string): Promise<string | null> => {
    try {
      const abs = path.resolve(root, rel);
      // lexical sandbox — the analyzer only feeds tree paths, but belt & braces
      if (abs !== root && !abs.startsWith(root + path.sep)) return null;
      const st = await fs.stat(abs);
      if (!st.isFile() || st.size > READER_MAX_BYTES) return null;
      if (st.size === 0) return "";
      const handle = await fs.open(abs, "r");
      try {
        const sniffLen = Math.min(st.size, SNIFF_BYTES);
        const sniff = Buffer.alloc(sniffLen);
        const { bytesRead } = await handle.read(sniff, 0, sniffLen, 0);
        if (looksBinary(sniff.subarray(0, bytesRead))) return null;
        const buf = Buffer.alloc(st.size);
        const { bytesRead: total } = await handle.read(buf, 0, st.size, 0);
        return buf.subarray(0, total).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  };
}

// ── the route ────────────────────────────────────────────────

const FEED_VERSION = "4.9.0";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rootParam = url.searchParams.get("root");
    const rootOverride = rootParam ? rootParam.replace(/^[./\\]+|\\/g, "").trim() || null : null;

    const tree = await buildWorkspaceTree();
    const sig = computeSignature(flatten(tree.tree));

    if (cache && cache.sig === sig && cache.root === rootOverride) {
      return NextResponse.json(cache.analysis, { headers: NO_STORE });
    }

    const reader = await makeReader(tree.root);
    const analysis = await analyzeStackBlitzProject(
      tree.tree as unknown as SBTreeNode[],
      reader,
      rootOverride ? { root: rootOverride } : undefined
    );

    // cache the versioned feed so hits and misses are identical
    const versioned: SBAnalysis = { ...analysis, v: FEED_VERSION };
    cache = { sig, root: rootOverride, analysis: versioned };
    return NextResponse.json(versioned, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : "stackblitz analysis failed";
    return NextResponse.json({ mode: "none", project: null, meta: null, error: message }, {
      status: 500,
      headers: NO_STORE,
    });
  }
}
