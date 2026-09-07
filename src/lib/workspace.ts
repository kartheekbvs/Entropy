// ─────────────────────────────────────────────────────────────
// Workspace Explorer library (v3.6) — the "VS Code panel" backend.
//
// Server-side helpers that power /api/workspace/*:
//   • buildWorkspaceTree()  — recursive, sorted (folders first),
//     depth/count-capped, node_modules/.git/.agent-shell ignored
//   • readWorkspaceFile()   — sandboxed single-file read, binary
//     sniffing, 256 KB inline cap (line-boundary truncated) and
//     language metadata for the syntax-highlighted viewer
//   • serveRawFile()        — mime-mapped raw download / inline
//   • buildWorkspaceZip()   — jszip archive for "Download
//     workspace" (feed the agent's code to any other AI model)
//
// Safety mirrors coding-tools.ts: every user-supplied path is
// resolved lexically (absolute + ../ escapes rejected) AND checked
// against realpath (symlink escapes rejected). Symlinks themselves
// are never followed by the walkers — a workspace symlink can't
// leak files from outside the sandbox into the tree or the zip.
//
// The workspace root mirrors WORKSPACE_ROOT in coding-tools.ts but
// resolves LAZILY (env read at call time), so AGENT_WORKSPACE edits
// in .env are picked up without a dev-server restart — same
// philosophy as the lazy LLM-key getters in llm.ts.
// ─────────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import JSZip from "jszip";

// ── Errors ───────────────────────────────────────────────────

export class WorkspaceApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WorkspaceApiError";
    this.status = status;
  }
}

// ── Root + sandbox ───────────────────────────────────────────

/** Workspace root, resolved at CALL time (AGENT_WORKSPACE override wins).
 * v5.2 — anchors to ENTROPY_PROJECT_ROOT when the standalone production
 * server has chdir'd into .next/standalone (files must land in the REAL
 * project workspace, not the build folder). */
export function getWorkspaceRoot(): string {
  const override = process.env.AGENT_WORKSPACE?.trim();
  const base =
    process.env.ENTROPY_PROJECT_ROOT?.trim() || process.cwd();
  return path.resolve(override ? override : path.join(base, "workspace"));
}

/** Directories/files never shown in the tree and never zipped. */
export const TREE_IGNORE = new Set([
  "node_modules",
  ".git",
  ".agent-shell", // agent runtime machinery (todo store, bg logs) — not deliverable code
  ".agent-state", // v3.7 run checkpoints (resume memory) — runtime state, not code
  ".archive", // v4.0 previous projects, archived on reset — recoverable on disk, hidden from the explorer/zip
  ".DS_Store",
  "Thumbs.db",
  "$RECYCLE.BIN",
]);

/** Resolve a user-supplied relative path inside the workspace; throw on escape. */
export function safeResolve(root: string, rel: string): string {
  const clean = String(rel ?? "").trim().replace(/^["']|["']$/g, "");
  if (!clean) throw new WorkspaceApiError("path parameter is required", 400);
  if (clean.includes("\0")) throw new WorkspaceApiError("invalid path", 400);
  if (path.isAbsolute(clean)) {
    throw new WorkspaceApiError(
      "absolute paths are not allowed — use a path relative to the workspace",
      400
    );
  }
  const abs = path.resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new WorkspaceApiError("path escapes the workspace sandbox", 400);
  }
  return abs;
}

/** Containment check that survives symlinks (realpath-based). */
async function assertInsideRoot(root: string, abs: string): Promise<void> {
  let realRoot = root;
  let realAbs = abs;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return; // root missing → the lexical check above already passed
  }
  try {
    realAbs = await fs.realpath(abs);
  } catch {
    return; // target doesn't exist yet — lexical check already passed
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw new WorkspaceApiError("path resolves outside the workspace sandbox (symlink?)", 400);
  }
}

// ── Tree ─────────────────────────────────────────────────────

export interface WorkspaceNode {
  name: string;
  /** Relative to the workspace root, POSIX separators. */
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  children?: WorkspaceNode[];
}

export interface WorkspaceTreeMeta {
  root: string;
  tree: WorkspaceNode[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  truncated: boolean;
  generatedAt: number;
}

const MAX_DEPTH = 14;
const MAX_NODES = 4000;

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Recursive, sorted, capped workspace listing. Symlinks are skipped. */
export async function buildWorkspaceTree(
  root = getWorkspaceRoot()
): Promise<WorkspaceTreeMeta> {
  const meta: WorkspaceTreeMeta = {
    root,
    tree: [],
    fileCount: 0,
    dirCount: 0,
    totalBytes: 0,
    truncated: false,
    generatedAt: Date.now(),
  };

  async function walk(abs: string, depth: number): Promise<WorkspaceNode[]> {
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      return []; // unreadable dir → skip; the tree stays truthful about the rest
    }
    const nodes: WorkspaceNode[] = [];
    const sorted = dirents
      .filter((d) => !TREE_IGNORE.has(d.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });
    for (const d of sorted) {
      if (meta.fileCount + meta.dirCount >= MAX_NODES) {
        meta.truncated = true;
        break;
      }
      if (d.isSymbolicLink()) continue; // never follow — can't leak outside files
      const childAbs = path.join(abs, d.name);
      let st;
      try {
        st = await fs.stat(childAbs);
      } catch {
        continue;
      }
      const node: WorkspaceNode = {
        name: d.name,
        path: toRel(root, childAbs),
        type: d.isDirectory() ? "dir" : "file",
        size: d.isDirectory() ? 0 : st.size,
        mtime: st.mtimeMs,
      };
      if (d.isDirectory()) {
        meta.dirCount++;
        if (depth < MAX_DEPTH) {
          node.children = await walk(childAbs, depth + 1);
        } else {
          meta.truncated = true;
        }
      } else {
        meta.fileCount++;
        meta.totalBytes += st.size;
      }
      nodes.push(node);
    }
    return nodes;
  }

  try {
    await fs.stat(root);
  } catch {
    return meta; // no workspace yet → empty tree (honest, not an error)
  }
  meta.tree = await walk(root, 0);
  return meta;
}

/** Newest file anywhere in a tree (for auto-follow during live runs). */
export function findNewestFile(nodes: WorkspaceNode[]): WorkspaceNode | null {
  let best: WorkspaceNode | null = null;
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as WorkspaceNode;
    if (n.type === "file") {
      if (!best || n.mtime > best.mtime) best = n;
    } else if (n.children) {
      stack.push(...n.children);
    }
  }
  return best;
}

// ── File classification (language + mime) ────────────────────

interface FileClass {
  label: string;
  prism: string;
  kind: "text" | "image";
  mime: string;
}

const PLAIN: FileClass = { label: "Plain text", prism: "textfile", kind: "text", mime: "text/plain; charset=utf-8" };

const EXT_MAP: Record<string, FileClass> = {
  ts: { label: "TypeScript", prism: "typescript", kind: "text", mime: "text/plain; charset=utf-8" },
  tsx: { label: "TSX", prism: "tsx", kind: "text", mime: "text/plain; charset=utf-8" },
  js: { label: "JavaScript", prism: "javascript", kind: "text", mime: "text/javascript" },
  mjs: { label: "JavaScript", prism: "javascript", kind: "text", mime: "text/javascript" },
  cjs: { label: "JavaScript", prism: "javascript", kind: "text", mime: "text/javascript" },
  jsx: { label: "JSX", prism: "jsx", kind: "text", mime: "text/javascript" },
  json: { label: "JSON", prism: "json", kind: "text", mime: "application/json" },
  html: { label: "HTML", prism: "markup", kind: "text", mime: "text/html; charset=utf-8" },
  htm: { label: "HTML", prism: "markup", kind: "text", mime: "text/html; charset=utf-8" },
  xml: { label: "XML", prism: "markup", kind: "text", mime: "application/xml" },
  svg: { label: "SVG", prism: "markup", kind: "image", mime: "image/svg+xml" },
  css: { label: "CSS", prism: "css", kind: "text", mime: "text/css" },
  scss: { label: "SCSS", prism: "scss", kind: "text", mime: "text/css" },
  sass: { label: "Sass", prism: "sass", kind: "text", mime: "text/css" },
  less: { label: "Less", prism: "less", kind: "text", mime: "text/css" },
  md: { label: "Markdown", prism: "markdown", kind: "text", mime: "text/markdown; charset=utf-8" },
  markdown: { label: "Markdown", prism: "markdown", kind: "text", mime: "text/markdown; charset=utf-8" },
  py: { label: "Python", prism: "python", kind: "text", mime: "text/x-python" },
  sh: { label: "Shell", prism: "bash", kind: "text", mime: "text/x-shellscript" },
  bash: { label: "Shell", prism: "bash", kind: "text", mime: "text/x-shellscript" },
  zsh: { label: "Shell", prism: "bash", kind: "text", mime: "text/x-shellscript" },
  yml: { label: "YAML", prism: "yaml", kind: "text", mime: "text/yaml" },
  yaml: { label: "YAML", prism: "yaml", kind: "text", mime: "text/yaml" },
  toml: { label: "TOML", prism: "toml", kind: "text", mime: "text/plain; charset=utf-8" },
  ini: { label: "INI", prism: "ini", kind: "text", mime: "text/plain; charset=utf-8" },
  cfg: { label: "Config", prism: "ini", kind: "text", mime: "text/plain; charset=utf-8" },
  env: { label: "Env", prism: "ini", kind: "text", mime: "text/plain; charset=utf-8" },
  sql: { label: "SQL", prism: "sql", kind: "text", mime: "text/plain; charset=utf-8" },
  csv: { label: "CSV", prism: "textfile", kind: "text", mime: "text/csv" },
  tsv: { label: "TSV", prism: "textfile", kind: "text", mime: "text/tab-separated-values" },
  go: { label: "Go", prism: "go", kind: "text", mime: "text/plain; charset=utf-8" },
  rs: { label: "Rust", prism: "rust", kind: "text", mime: "text/plain; charset=utf-8" },
  java: { label: "Java", prism: "java", kind: "text", mime: "text/plain; charset=utf-8" },
  c: { label: "C", prism: "c", kind: "text", mime: "text/plain; charset=utf-8" },
  h: { label: "C header", prism: "c", kind: "text", mime: "text/plain; charset=utf-8" },
  cpp: { label: "C++", prism: "cpp", kind: "text", mime: "text/plain; charset=utf-8" },
  cc: { label: "C++", prism: "cpp", kind: "text", mime: "text/plain; charset=utf-8" },
  hpp: { label: "C++ header", prism: "cpp", kind: "text", mime: "text/plain; charset=utf-8" },
  rb: { label: "Ruby", prism: "ruby", kind: "text", mime: "text/plain; charset=utf-8" },
  php: { label: "PHP", prism: "php", kind: "text", mime: "text/plain; charset=utf-8" },
  swift: { label: "Swift", prism: "swift", kind: "text", mime: "text/plain; charset=utf-8" },
  kt: { label: "Kotlin", prism: "kotlin", kind: "text", mime: "text/plain; charset=utf-8" },
  txt: { label: "Plain text", prism: "textfile", kind: "text", mime: "text/plain; charset=utf-8" },
  log: { label: "Log", prism: "textfile", kind: "text", mime: "text/plain; charset=utf-8" },
  lock: { label: "Lockfile", prism: "textfile", kind: "text", mime: "text/plain; charset=utf-8" },
  png: { label: "PNG image", prism: "textfile", kind: "image", mime: "image/png" },
  jpg: { label: "JPEG image", prism: "textfile", kind: "image", mime: "image/jpeg" },
  jpeg: { label: "JPEG image", prism: "textfile", kind: "image", mime: "image/jpeg" },
  gif: { label: "GIF image", prism: "textfile", kind: "image", mime: "image/gif" },
  webp: { label: "WebP image", prism: "textfile", kind: "image", mime: "image/webp" },
  bmp: { label: "Bitmap image", prism: "textfile", kind: "image", mime: "image/bmp" },
  ico: { label: "Icon", prism: "textfile", kind: "image", mime: "image/x-icon" },
};

const BASENAME_MAP: Record<string, FileClass> = {
  dockerfile: { label: "Dockerfile", prism: "docker", kind: "text", mime: "text/plain; charset=utf-8" },
  makefile: { label: "Makefile", prism: "makefile", kind: "text", mime: "text/plain; charset=utf-8" },
  ".gitignore": { label: "Git ignore", prism: "textfile", kind: "text", mime: "text/plain; charset=utf-8" },
  ".env": { label: "Env", prism: "ini", kind: "text", mime: "text/plain; charset=utf-8" },
};

function classify(name: string): FileClass {
  const lower = name.toLowerCase();
  if (BASENAME_MAP[lower]) return BASENAME_MAP[lower];
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return EXT_MAP[ext] ?? PLAIN;
}

export function mimeForPath(rel: string): string {
  return classify(path.basename(rel)).mime;
}

// ── File read ────────────────────────────────────────────────

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  /** Text content (empty string for binary/image kinds). */
  content: string;
  lines: number;
  language: string;
  prism: string;
  kind: "text" | "image" | "binary";
}

const MAX_INLINE_BYTES = 256 * 1024; // 256 KB in the viewer
const SNIFF_BYTES = 8192;

function isBinaryHead(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true; // NUL byte → binary
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true; // invalid UTF-8 → binary
  }
}

/**
 * Sandboxed single-file read with binary sniffing and a 256 KB
 * inline cap. Truncation happens on a line boundary so the viewer
 * never renders a half-cut final line.
 */
export async function readWorkspaceFile(
  rel: string,
  root = getWorkspaceRoot()
): Promise<WorkspaceFile> {
  const abs = safeResolve(root, rel);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new WorkspaceApiError(`file not found: ${rel}`, 404);
  }
  if (!st.isFile()) throw new WorkspaceApiError(`not a file: ${rel}`, 400);
  await assertInsideRoot(root, abs);

  const name = path.basename(abs);
  const cls = classify(name);
  const base: WorkspaceFile = {
    path: rel,
    name,
    size: st.size,
    mtime: st.mtimeMs,
    binary: false,
    truncated: false,
    content: "",
    lines: 0,
    language: cls.label,
    prism: cls.prism,
    kind: cls.kind,
  };

  if (cls.kind === "image") {
    base.binary = true; // viewer fetches it via the raw endpoint
    return base;
  }

  const handle = await fs.open(abs, "r");
  try {
    // 1. Binary sniff on the head
    const sniffLen = Math.min(st.size, SNIFF_BYTES);
    if (sniffLen > 0) {
      const sniff = Buffer.alloc(sniffLen);
      const { bytesRead } = await handle.read(sniff, 0, sniffLen, 0);
      if (isBinaryHead(sniff.subarray(0, bytesRead))) {
        base.binary = true;
        base.kind = "binary";
        return base;
      }
    }
    // 2. Text content (capped)
    if (st.size === 0) return base;
    const readLen = Math.min(st.size, MAX_INLINE_BYTES + 1);
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await handle.read(buf, 0, readLen, 0);
    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (st.size > bytesRead) {
      // cut at the last newline so the final rendered line is whole
      const lastNl = text.lastIndexOf("\n");
      text = lastNl > 0 ? text.slice(0, lastNl) : text.slice(0, MAX_INLINE_BYTES);
      base.truncated = true;
    }
    base.content = text;
    // editor-style line counting: a trailing newline does not start a new line
    base.lines = text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
    return base;
  } finally {
    await handle.close();
  }
}

// ── Raw serving (single-file download / inline image) ────────

const MAX_RAW_BYTES = 100 * 1024 * 1024; // 100 MB

export async function serveRawFile(
  rel: string,
  root = getWorkspaceRoot()
): Promise<{ buffer: Buffer; mime: string; name: string }> {
  const abs = safeResolve(root, rel);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new WorkspaceApiError(`file not found: ${rel}`, 404);
  }
  if (!st.isFile()) throw new WorkspaceApiError(`not a file: ${rel}`, 400);
  if (st.size > MAX_RAW_BYTES) {
    throw new WorkspaceApiError(`file too large to download (${st.size} bytes)`, 413);
  }
  await assertInsideRoot(root, abs);
  const buffer = await fs.readFile(abs);
  return { buffer, mime: classify(path.basename(abs)).mime, name: path.basename(abs) };
}

// ── ZIP export ───────────────────────────────────────────────

// ── v4.0 NEW PROJECT reset ─────────────────────────────────────
// The user's rule: “after one project the files are still there —
// they have to go when a new workspace starts.” resetWorkspace()
// clears the stage for a fresh project WITHOUT destroying anything:
// archive=true moves every visible entry into workspace/.archive/
// <timestamp>/ (hidden from the explorer + zip, recoverable on
// disk); archive=false deletes for-real. Old run checkpoints are
// retired either way — a clean project gets a clean agent state —
// and a fresh AGENT.md starter is written so project memory begins
// from scratch.
const FRESH_AGENT_MD = `# AGENT.md — project memory

Persistent notes for the autonomous coding agent (written by you and
by the agent across runs). Keep it short and operational.

## Project
- (what the current project is)

## Conventions
- (paths, ports, commands the agent should reuse)

## Lessons learned
- (what worked / what failed — the agent reads this at every run start)
`;

export interface WorkspaceResetResult {
  ok: boolean;
  archivedTo: string | null;
  itemsCleared: number;
  agentMdPath: string;
}

export async function resetWorkspace(opts: { archive: boolean }): Promise<WorkspaceResetResult> {
  const root = getWorkspaceRoot();
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  let moved = 0;
  let stamp: string | null = null;

  if (opts.archive) {
    stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveDir = path.join(root, ".archive", stamp);
    await fs.mkdir(archiveDir, { recursive: true });
    for (const entry of entries) {
      if (entry.name === ".archive") continue;
      try {
        await fs.rename(path.join(root, entry.name), path.join(archiveDir, entry.name));
        moved++;
      } catch {
        // cross-device or locked (Windows open handle) — fall back to delete
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined);
        moved++;
      }
    }
  } else {
    for (const entry of entries) {
      if (entry.name === ".archive") continue;
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => undefined);
      moved++;
    }
  }

  const agentMdPath = path.join(root, "AGENT.md");
  await fs.writeFile(agentMdPath, FRESH_AGENT_MD, "utf8");
  return { ok: true, archivedTo: stamp, itemsCleared: moved, agentMdPath };
}

export interface WorkspaceZip {
  buffer: Buffer;
  fileCount: number;
}

const MAX_ZIP_FILES = 20_000;
const MAX_ZIP_UNCOMPRESSED = 512 * 1024 * 1024;

/** Flat listing with the same ignore rules as the tree. Symlinks skipped. */
export async function listWorkspaceFiles(
  root = getWorkspaceRoot()
): Promise<Array<{ abs: string; rel: string; size: number }>> {
  const out: Array<{ abs: string; rel: string; size: number }> = [];
  const queue: Array<{ abs: string; depth: number }> = [{ abs: root, depth: 0 }];
  while (queue.length > 0) {
    const { abs, depth } = queue.shift() as { abs: string; depth: number };
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (TREE_IGNORE.has(d.name) || d.isSymbolicLink()) continue;
      const childAbs = path.join(abs, d.name);
      if (d.isDirectory()) {
        if (depth < MAX_DEPTH) queue.push({ abs: childAbs, depth: depth + 1 });
      } else {
        let st;
        try {
          st = await fs.stat(childAbs);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        out.push({ abs: childAbs, rel: toRel(root, childAbs), size: st.size });
        if (out.length > MAX_ZIP_FILES) {
          throw new WorkspaceApiError("workspace has too many files to zip", 413);
        }
      }
    }
  }
  return out;
}

/**
 * Build a DEFLATE zip of the whole workspace (node_modules, .git and
 * .agent-shell excluded) — the artifact you hand to other AI models
 * or open in any editor.
 */
export async function buildWorkspaceZip(root = getWorkspaceRoot()): Promise<WorkspaceZip> {
  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch {
    throw new WorkspaceApiError("the workspace is empty — nothing to export yet", 404);
  }
  if (!rootStat.isDirectory()) {
    throw new WorkspaceApiError("workspace root is not a directory", 500);
  }

  const files = await listWorkspaceFiles(root);
  if (files.length === 0) {
    throw new WorkspaceApiError("the workspace is empty — nothing to export yet", 404);
  }
  const totalUncompressed = files.reduce((sum, f) => sum + f.size, 0);
  if (totalUncompressed > MAX_ZIP_UNCOMPRESSED) {
    throw new WorkspaceApiError(
      `workspace too large to zip (${(totalUncompressed / 1024 / 1024).toFixed(0)} MB uncompressed)`,
      413
    );
  }

  const zip = new JSZip();
  for (const f of files) {
    const data = await fs.readFile(f.abs);
    zip.file(f.rel, data);
  }
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 4 },
  });
  return { buffer, fileCount: files.length };
}
