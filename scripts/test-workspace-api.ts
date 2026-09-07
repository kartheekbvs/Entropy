// ─────────────────────────────────────────────────────────────
// test-workspace-api.ts — v3.6 regression test for the Workspace
// Explorer backend (src/lib/workspace.ts + /api/workspace/*).
//
// PART A — library unit tests on a temp workspace:
//   tree shape/sorting/ignore rules, symlink skipping, sandboxed
//   reads (traversal + absolute + symlink escapes), binary
//   sniffing, 256 KB line-boundary truncation, language/mime
//   classification, zip building (verified with unzip -t)
//
// PART B — live HTTP tests against the dev server (:3000):
//   tree 200 + shape, file 200 + content matches disk, raw
//   download with mime + disposition, security guards 400/404,
//   zip download (PK magic, unzip -t, node_modules excluded),
//   and a REAL-TIME simulation: a file "lands" mid-poll and the
//   tree endpoint shows it on the very next request.
//
// Run: bun scripts/test-workspace-api.ts
// ─────────────────────────────────────────────────────────────
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWorkspaceTree,
  buildWorkspaceZip,
  readWorkspaceFile,
  serveRawFile,
  listWorkspaceFiles,
  safeResolve,
  WorkspaceApiError,
} from "../src/lib/workspace";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

const BASE = "http://localhost:3000";
async function httpJson(pathname: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${pathname}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ═════════════════════════════════════════════════════════════
console.log("\n── PART A · workspace library (temp workspace) ──");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wsexp-"));

// fixture:
//   dashboard/{index.html, server.js, data.json}
//   AGENT.md
//   node_modules/express/index.js        (must be ignored)
//   .agent-shell/todos.json              (must be ignored)
//   big.txt (300 KB)                     (truncation path)
//   image.png (NUL bytes)                (binary path)
//   outside-link -> /etc                 (symlink must be skipped)
await fs.mkdir(path.join(tmp, "dashboard"), { recursive: true });
await fs.mkdir(path.join(tmp, "node_modules", "express"), { recursive: true });
await fs.mkdir(path.join(tmp, ".agent-shell"), { recursive: true });
await fs.writeFile(path.join(tmp, "dashboard", "index.html"), "<html><body>hello</body></html>\n");
await fs.writeFile(path.join(tmp, "dashboard", "server.js"), "const express = require('express');\n");
await fs.writeFile(path.join(tmp, "dashboard", "data.json"), JSON.stringify({ ok: true }));
await fs.writeFile(path.join(tmp, "AGENT.md"), "# agent memory\n");
await fs.writeFile(path.join(tmp, "node_modules", "express", "index.js"), "module.exports = {};\n");
await fs.writeFile(path.join(tmp, ".agent-shell", "todos.json"), "[]");
await fs.writeFile(path.join(tmp, "big.txt"), "line\n".repeat(60_000)); // ~300 KB
await fs.writeFile(path.join(tmp, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
await fs.writeFile(path.join(tmp, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
try {
  await fs.symlink("/etc", path.join(tmp, "outside-link"));
} catch {
  /* platforms without symlink rights — those sections self-skip */
}

// ── A1 · tree ──
const meta = await buildWorkspaceTree(tmp);
check("tree: root echoed", meta.root === tmp);
check(
  "tree: node_modules + .agent-shell ignored",
  !JSON.stringify(meta).includes("node_modules") && !JSON.stringify(meta).includes("todos.json"),
);
check(
  "tree: symlinks skipped",
  !JSON.stringify(meta).includes("outside-link"),
  "symlink appeared in tree",
);
check(
  "tree: expected files present",
  JSON.stringify(meta).includes("dashboard/index.html") && JSON.stringify(meta).includes("AGENT.md"),
);
const dash = meta.tree.find((n) => n.name === "dashboard");
check("tree: folders sort before files", (meta.tree[0]?.type ?? "") === "dir");
check(
  "tree: sizes + mtimes are numbers",
  meta.tree.every((n) => typeof n.size === "number" && typeof n.mtime === "number"),
);
check(
  "tree: fileCount/totalBytes consistent with walk",
  meta.fileCount === 7 && dash?.children?.length === 3,
  `fileCount=${meta.fileCount}, dash children=${dash?.children?.length}`,
);

// ── A2 · sandbox resolution ──
function isRejected(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof WorkspaceApiError;
  }
}
check("guard: ../ escape rejected", isRejected(() => safeResolve(tmp, "../../etc/passwd")));
check("guard: absolute path rejected", isRejected(() => safeResolve(tmp, "/etc/passwd")));
check("guard: empty path rejected", isRejected(() => safeResolve(tmp, "")));
check("guard: null byte rejected", isRejected(() => safeResolve(tmp, "a\0b")));
check("guard: plain relative path resolves inside", safeResolve(tmp, "dashboard/server.js").startsWith(tmp));
// symlink escape: resolve a path THROUGH a workspace symlink
let symlinkEscapeRejected = false;
try {
  const linkTarget = path.join(tmp, "outside-link", "passwd");
  safeResolve(tmp, "outside-link/passwd");
  // lexical pass is expected; the realpath containment must still reject reads
  symlinkEscapeRejected = false;
  await readWorkspaceFile("outside-link/passwd", tmp).then(
    () => (symlinkEscapeRejected = false),
    (e: unknown) => (symlinkEscapeRejected = e instanceof WorkspaceApiError)
  );
  void linkTarget;
} catch {
  symlinkEscapeRejected = true;
}
check("guard: reading through a symlink escapes is rejected", symlinkEscapeRejected);

// ── A3 · file reads ──
const html = await readWorkspaceFile("dashboard/index.html", tmp);
check("read: content + language", html.content.includes("hello") && html.language === "HTML" && html.prism === "markup");
check("read: lines counted", html.lines === 1, `lines=${html.lines}`);
const png = await readWorkspaceFile("image.png", tmp);
check("read: images classify as image kind (inline preview)", png.binary && png.kind === "image");
const blob = await readWorkspaceFile("blob.bin", tmp);
check("read: binary sniffing (NUL byte)", blob.binary && blob.kind === "binary" && blob.content === "");
const pngRaw = await serveRawFile("image.png", tmp);
check("raw: mime mapping for png", pngRaw.mime === "image/png" && pngRaw.name === "image.png");
const big = await readWorkspaceFile("big.txt", tmp);
check(
  "read: 256 KB cap + line-boundary truncation (no partial last line)",
  big.truncated && big.content.length <= 256 * 1024 && big.content.endsWith("line"),
  `len=${big.content.length}, truncated=${big.truncated}`,
);
try {
  await readWorkspaceFile("missing.txt", tmp);
  check("read: missing file → 404", false);
} catch (e) {
  check("read: missing file → 404", e instanceof WorkspaceApiError && e.status === 404);
}
try {
  await serveRawFile("dashboard", tmp);
  check("raw: directory → 400", false);
} catch (e) {
  check("raw: directory → 400", e instanceof WorkspaceApiError && e.status === 400);
}

// ── A4 · zip ──
const flat = await listWorkspaceFiles(tmp);
check(
  "zip listing: ignores + symlink-free",
  flat.length === 7 && flat.every((f) => !f.rel.includes("node_modules") && !f.rel.includes("outside-link")),
  `files=${flat.length}`,
);
const zip = await buildWorkspaceZip(tmp);
check("zip: buffer starts with PK", zip.buffer.length > 0 && zip.buffer[0] === 0x50 && zip.buffer[1] === 0x4b);
check("zip: fileCount matches listing", zip.fileCount === flat.length);
const zipPath = path.join(tmp, "test.zip");
await fs.writeFile(zipPath, zip.buffer);
try {
  const out = execSync(`unzip -t "${zipPath}" 2>&1`).toString();
  check("zip: unzip -t integrity", out.includes("No errors detected"), out.slice(-120));
  const listing = execSync(`unzip -l "${zipPath}" 2>&1`).toString();
  check("zip: AGENT.md + dashboard inside", listing.includes("AGENT.md") && listing.includes("dashboard/index.html"));
  check("zip: node_modules NOT inside", !listing.includes("node_modules"));
} catch (e) {
  check("zip: unzip -t integrity", false, String(e));
}

// empty workspace → clean 404, not a crash
const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "wsempty-"));
try {
  await buildWorkspaceZip(emptyDir);
  check("zip: empty workspace → friendly 404", false);
} catch (e) {
  check("zip: empty workspace → friendly 404", e instanceof WorkspaceApiError && e.status === 404);
}
const emptyTree = await buildWorkspaceTree(emptyDir);
check("tree: empty workspace → empty tree (not an error)", emptyTree.tree.length === 0 && emptyTree.fileCount === 0);

await fs.rm(tmp, { recursive: true, force: true });
await fs.rm(emptyDir, { recursive: true, force: true });

// ═════════════════════════════════════════════════════════════
console.log("\n── PART B · live HTTP (dev server :3000) ──");

// ── B1 · tree ──
const t = await httpJson("/api/workspace/tree");
check("GET /api/workspace/tree → 200", t.status === 200);
const treeBody = t.body as unknown as { tree: unknown[]; fileCount: number; totalBytes: number; root: string };
check(
  "tree payload shape",
  Array.isArray(treeBody.tree) && typeof treeBody.fileCount === "number" && typeof treeBody.totalBytes === "number" && typeof treeBody.root === "string",
);
check("tree: live workspace served", treeBody.root.endsWith("workspace"));

// ── B2 · file + raw + guards ──
const f = await httpJson("/api/workspace/file?path=AGENT.md");
check("GET file → 200 + fields", f.status === 200 && typeof (f.body as { content?: string }).content === "string");
const disk = await fs.readFile(path.join(treeBody.root, "AGENT.md"), "utf8");
check(
  "file content matches disk byte-for-byte",
  (f.body as { content: string }).content === disk,
);
const rawRes = await fetch(`${BASE}/api/workspace/file?path=AGENT.md&raw=1`);
check(
  "GET raw → text mime + attachment disposition",
  rawRes.status === 200 &&
    (rawRes.headers.get("content-type") ?? "").startsWith("text/") &&
    (rawRes.headers.get("content-disposition") ?? "").startsWith("attachment"),
);
check("raw bytes match disk", (await rawRes.text()) === disk);
const guardCases: Array<[string, number]> = [
  ["?path=../package.json", 400],
  ["?path=/etc/passwd", 400],
  ["?path=missing-nope.js", 404],
  ["", 400],
];
for (const [q, expect] of guardCases) {
  const g = await httpJson(`/api/workspace/file${q}`);
  check(`guard ${q || "(empty)"} → ${expect}`, g.status === expect, `got ${g.status}`);
}

// ── B3 · download ──
const dl = await fetch(`${BASE}/api/workspace/download`);
check("GET /api/workspace/download → 200 zip", dl.status === 200 && (dl.headers.get("content-type") ?? "") === "application/zip");
check(
  "download: stamped filename + count header",
  /workspace-\d{4}-\d{2}-\d{2}\.zip/.test(dl.headers.get("content-disposition") ?? "") &&
    Number(dl.headers.get("x-file-count") ?? "0") > 0,
);
const dlBytes = Buffer.from(await dl.arrayBuffer());
check("download: PK magic", dlBytes[0] === 0x50 && dlBytes[1] === 0x4b);
const dlZip = path.join(os.tmpdir(), `wsdl-${Date.now()}.zip`);
await fs.writeFile(dlZip, dlBytes);
try {
  const out = execSync(`unzip -t "${dlZip}" 2>&1`).toString();
  check("download: unzip -t integrity", out.includes("No errors detected"));
  const listing = execSync(`unzip -l "${dlZip}" 2>&1`).toString();
  check("download: dashboard files inside", listing.includes("dashboard/index.html") || listing.includes("AGENT.md"));
  check("download: node_modules excluded", !listing.includes("node_modules/"));
} catch (e) {
  check("download: unzip -t integrity", false, String(e));
} finally {
  await fs.rm(dlZip, { force: true });
}

// ── B4 · real-time: a file "lands" and the next tree poll sees it ──
const probePath = path.join(treeBody.root, "_live_probe_test.txt");
await fs.writeFile(probePath, "created mid-run by the test\n");
try {
  const t2 = await httpJson("/api/workspace/tree");
  const flatPaths = JSON.stringify((t2.body as { tree: unknown[] }).tree);
  check("real-time: new file visible on next poll", flatPaths.includes("_live_probe_test.txt"));
  const f2 = await httpJson("/api/workspace/file?path=_live_probe_test.txt");
  check(
    "real-time: new file readable via API",
    f2.status === 200 && (f2.body as { content: string }).content === "created mid-run by the test\n",
  );
} finally {
  await fs.rm(probePath, { force: true });
}
const t3 = await httpJson("/api/workspace/tree");
check("real-time: cleanup reflected (file gone)", !JSON.stringify(t3.body).includes("_live_probe_test.txt"));

// ═════════════════════════════════════════════════════════════
console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
