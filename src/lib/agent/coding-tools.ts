// ─────────────────────────────────────────────────────────────
// Claude-Code-style coding tools for the autonomous agent.
//
// Gives the agent REAL engineering power — create folders, write
// and EDIT files, read code with line ranges, glob/grep, track a
// build plan, run shell commands — inside a hard sandbox:
//
//   • Every path is resolved + contained inside the WORKSPACE root
//     (default: <project>/workspace, override with AGENT_WORKSPACE)
//   • Cross-platform shell engine: bash (unix + Git Bash on
//     Windows) with an automatic cmd.exe fallback — detected once,
//     reported to the model, with a conservative alias translator
//     so common bash idioms still work on pure-Windows machines
//   • Background processes are spawned by NODE (detached, stdio →
//     log file, real pid) — works identically on Linux/mac/Windows
//     and returns a killable pid
//   • Shell commands run with an allowlist for the first token of
//     every segment, a hard blocklist (sudo / rm -rf / / pipes /
//     fork bombs / parent-path escapes), timeouts with a
//     process-tree kill, and output caps
//   • shell_run is additionally rate-limited (AGENT_RATE_SHELL/min)
//
// These ToolDefs plug into the exact same registry, agent loop and
// MCP server as the job tools — one protocol, two superpowers.
// ─────────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { promises as fs, createWriteStream as createWriteStreamCb, type WriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";

const fsSync = { createWriteStream: createWriteStreamCb as (p: string) => WriteStream };
import type { ToolDef } from "./tools";
import { rateLimit } from "./rate-limit";
import { publishPreviewWrite } from "@/lib/preview";

// ── Workspace sandbox ────────────────────────────────────────
export const WORKSPACE_ROOT = path.resolve(
  process.env.AGENT_WORKSPACE && process.env.AGENT_WORKSPACE.trim()
    ? process.env.AGENT_WORKSPACE.trim()
    : path.join(process.cwd(), "workspace")
);

const SHELL_LOG_DIR = path.join(WORKSPACE_ROOT, ".agent-shell");
const TODOS_FILE = path.join(SHELL_LOG_DIR, "todos.json");

/** Resolve a user-supplied path inside the workspace; throw on escape. */
function sandboxResolve(rel: string): string {
  const clean = String(rel ?? "").trim().replace(/^["']|["']$/g, "");
  if (!clean) return WORKSPACE_ROOT;
  // Reject absolute paths early with a clear message (Windows + unix)
  if (path.isAbsolute(clean)) {
    throw new Error(`path "${rel}" is absolute — use relative paths inside the workspace only`);
  }
  const abs = path.resolve(WORKSPACE_ROOT, clean);
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error(`path "${rel}" escapes the workspace sandbox — use relative paths inside the workspace only`);
  }
  return abs;
}

/** Containment check that survives symlinks (realpath-based). */
async function assertInsideWorkspace(abs: string): Promise<void> {
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    return; // target doesn't exist yet — the lexical check above already passed
  }
  let rootReal = WORKSPACE_ROOT;
  try {
    rootReal = await fs.realpath(WORKSPACE_ROOT);
  } catch {
    /* workspace not created yet */
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new Error("path resolves outside the workspace sandbox (symlink?)");
  }
}

async function ensureWorkspace(): Promise<void> {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
  await fs.mkdir(SHELL_LOG_DIR, { recursive: true });
}

// ── Binary detection for reads ───────────────────────────────
async function isBinary(abs: string): Promise<boolean> {
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, 4096, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

// ═════════════════════════════════════════════════════════════
// Cross-platform shell engine
//
// Claude Code itself requires Git Bash on Windows; we go further:
//   1. bash on PATH (unix, or Git Bash installed on Windows)
//   2. well-known Git Bash locations on Windows
//   3. cmd.exe fallback with a conservative bash-alias translator
// The detected dialect is reported to the model via the system
// prompt and workspace_info so it speaks the right command
// language for THIS machine — which is why the agent is reliable
// on any user's laptop, not just this sandbox.
// ═════════════════════════════════════════════════════════════

export interface ShellInfo {
  kind: "bash" | "cmd";
  command: string;
  prefixArgs: string[];
  label: string;
}

let detectedShell: ShellInfo | null = null;

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectShell(): Promise<ShellInfo> {
  if (detectedShell) return detectedShell;

  if (process.platform !== "win32") {
    // Unix/macOS — bash (fall back to sh if a minimal distro lacks bash)
    detectedShell = (await fileExists("/bin/bash"))
      ? { kind: "bash", command: "bash", prefixArgs: ["-c"], label: "bash" }
      : { kind: "bash", command: "sh", prefixArgs: ["-c"], label: "sh" };
    return detectedShell;
  }

  // Windows — prefer real bash (Git Bash), else cmd.exe
  const candidates = [
    process.env.AGENT_BASH_PATH, // explicit override
    "bash", // on PATH (Git Bash adds itself to PATH on install)
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.USERPROFILE ?? ""}\\scoop\\apps\\git\\current\\bin\\bash.exe`,
  ].filter(Boolean) as string[];

  for (const cand of candidates) {
    if (path.isAbsolute(cand) ? await fileExists(cand) : await whichExists(cand)) {
      detectedShell = { kind: "bash", command: cand, prefixArgs: ["-c"], label: `bash (${cand})` };
      return detectedShell;
    }
  }

  detectedShell = { kind: "cmd", command: "cmd", prefixArgs: ["/d", "/s", "/c"], label: "cmd.exe (fallback — install Git for Windows for full bash support)" };
  return detectedShell;
}

async function whichExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("where", [bin], { stdio: "ignore", shell: false });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

export async function getShellInfo(): Promise<ShellInfo> {
  return detectShell();
}

// ── Conservative bash→cmd translation ───────────────────────
// Only rewrites SIMPLE commands (single command, common flags) so
// the model's bash muscle-memory still works on pure cmd machines.
// Complex pipelines are left for the model, which is told the
// dialect in its system prompt.
const CMD_ALIASES: Array<{ re: RegExp; out: string }> = [
  { re: /^ls\s*$/, out: "dir /b" },
  { re: /^ls\s+(.*)$/, out: "dir /b $1" },
  { re: /^ls -l(a)?\s*(.*)$/, out: "dir /a$2" },
  { re: /^cat\s+(.+)$/, out: "type $1" },
  { re: /^touch\s+(.+)$/, out: "type nul > $1" },
  { re: /^cp\s+(.+?)\s+(.+)$/, out: "copy $1 $2" },
  { re: /^mv\s+(.+?)\s+(.+)$/, out: "move $1 $2" },
  { re: /^rm\s+(-[a-z]+\s+)?(.+)$/, out: "del /q $2" },
  { re: /^rm\s+-[a-z]*r[a-z]*\s+(.+)$/, out: "rd /s /q $1" },
  { re: /^mkdir\s+-p\s+(.+)$/, out: "md $1" },
  { re: /^mkdir\s+(.+)$/, out: "md $1" },
  { re: /^grep\s+(.+)$/, out: "findstr $1" },
  { re: /^python3\b(.*)$/, out: "python$1" },
  { re: /^pip3\b(.*)$/, out: "pip$1" },
  { re: /^echo\s+(.+)$/, out: "echo $1" },
  { re: /^pwd\s*$/, out: "cd" },
  { re: /^which\s+(.+)$/, out: "where $1" },
];

function translateForCmd(command: string): string {
  return command
    .split(/&&|\|\|/)
    .map((seg) => {
      const s = seg.trim();
      for (const { re, out } of CMD_ALIASES) {
        const m = s.match(re);
        if (m) return s.replace(re, out);
      }
      return s;
    })
    .join(command.includes("||") ? " || " : " && ")
    .replace(/&&\s*$/, "");
}

// ── Command validation (allowlist + blocklist) ───────────────

const ALLOWED_FIRST_TOKENS = new Set([
  "node", "bun", "bunx", "deno", "npm", "npx", "pnpm", "yarn",
  "python", "python3", "pip", "pip3", "git", "tsc", "eslint", "prettier",
  "pytest", "jest", "vite", "make", "gcc", "g++", "cargo", "go", "javac", "java",
  "mkdir", "rmdir", "md", "ls", "dir", "cat", "type", "echo", "printf", "touch", "cp", "copy", "mv", "move", "rm", "del", "rd", "ln", "pwd", "cd",
  "grep", "findstr", "rg", "find", "where", "which", "tail", "head", "wc", "sort", "uniq", "cut", "tr", "sed", "awk",
  "diff", "tar", "gzip", "gunzip", "zip", "unzip", "curl", "wget", "ping", "ps", "kill", "taskkill",
  "sleep", "date", "basename", "dirname", "stat", "du", "df", "free", "uname", "env",
  "whoami", "id", "chmod", "openssl", "sqlite3", "xargs", "test", "true", "false",
  "export", "set", "exec", "tasklist",
]);

// Hard blocklist — matched against the WHOLE command string
const DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bsudo\b|\bsu\s+-\b/i, why: "sudo/su is not allowed" },
  { re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\s+\/(\s|$|\*)/i, why: "rm -rf targeting filesystem root" },
  { re: /\brd\s+\/s\s+\/q\s+[a-z]:\\\s*$/i, why: "rd /s /q targeting a drive root" },
  { re: /\b(mkfs|shutdown|reboot|halt|poweroff)\b/i, why: "system power/format command" },
  { re: /\bdd\s+if=/i, why: "raw disk write (dd)" },
  { re: /:\s*\(\s*\)\s*\{/i, why: "fork bomb pattern" },
  { re: /\bformat\s+[a-z]:/i, why: "drive format" },
  { re: /\bchmod\s+-R\s+777\s+\//i, why: "chmod 777 on root" },
  { re: /(curl|wget)[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, why: "piping downloaded content into a shell" },
  { re: /\|\s*(sudo\s+)?(ba)?sh\s+-c/i, why: "pipe into shell -c" },
  { re: /\bbase64\s+-d\b[^|;&]*\|/i, why: "piping decoded base64 into a command" },
  { re: /\bcrontab\b|\bhistory\s+-c\b/i, why: "cron/history tampering" },
  { re: /\.\.[\\/]/, why: "parent-path (../) escapes the sandbox" },
  { re: /(^|[\s(=&;])~\//, why: "home-directory (~) escape" },
  { re: /\$HOME/i, why: "$HOME escape" },
  { re: /%USERPROFILE%|%APPDATA%|%SYSTEMROOT%/i, why: "Windows system-folder env escape" },
  { re: /\b(pkill|killall)\b/i, why: "use kill <pid> with the exact pid instead of pkill/killall" },
  { re: /\bkill\s+(-\S+\s+)*\b1\b(\s|$)/, why: "refusing to kill pid 1" },
  { re: /(^|[^0-9])>\s*\/(?!dev\/null\b)/, why: "redirect to an absolute path outside the sandbox" },
  { re: />\s*[a-z]:[\\/]/i, why: "redirect to a Windows absolute path" },
  { re: /\b(cd|pushd)\s+(\/|[A-Za-z]:\\|~)/i, why: "cd to an absolute/home path escapes the sandbox cwd" },
];

function stripEnvAssignments(seg: string): string {
  return seg.replace(/^(\([A-Z_][A-Z0-9_]*=\S*\s+)+/, "").replace(/^([A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
}

function validateCommand(command: string, shellKind: "bash" | "cmd"): { ok: true } | { ok: false; error: string } {
  const cmd = command.trim();
  if (!cmd) return { ok: false, error: "empty command" };
  if (cmd.length > 2000) return { ok: false, error: "command too long (2000 char max)" };

  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return { ok: false, error: `blocked: ${why}` };
  }

  // Validate the first token of every segment (split on && ; | ||)
  const segments = cmd.split(/&&|\|\||;|\|/);
  for (const rawSeg of segments) {
    const seg = stripEnvAssignments(rawSeg.trim().replace(/^\(+/, "").replace(/^!/, "").trim());
    if (!seg) continue;
    const first = seg.split(/\s+/)[0].replace(/^["']|["']$/g, "").toLowerCase();
    if (!ALLOWED_FIRST_TOKENS.has(first)) {
      return { ok: false, error: `"${first}" is not on the command allowlist — allowed: build tools (node/bun/npm/npx/python/pip/git/tsc...), file ops (ls/dir/cat/copy/move/del/mkdir/tar...), network fetch (curl/wget), process tools (ps/kill/taskkill/tasklist)` };
    }
  }
  return { ok: true };
}

function capOutput(s: string, limit = 32_000): string {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…[output truncated at ${limit} chars]`;
}

interface ShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  background?: boolean;
  pid?: number;
  logFile?: string;
  timedOut?: boolean;
}

// ── Process-tree kill, cross-platform ────────────────────────
async function killTree(pid: number): Promise<void> {
  if (!pid || pid <= 1) return;
  if (process.platform === "win32") {
    // taskkill kills the whole tree, no helper shell needed
    await new Promise<void>((resolve) => {
      const p = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    return;
  }
  // POSIX: kill the process group (detached spawns are session leaders)
  for (const sig of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-pid, sig as NodeJS.Signals);
    } catch {
      try {
        process.kill(pid, sig as NodeJS.Signals);
      } catch {
        /* already gone */
      }
    }
    if (sig === "SIGTERM") await new Promise((r) => setTimeout(r, 1200));
  }
}

// ── Foreground execution ─────────────────────────────────────
function runShell(fullCommand: string, timeoutMs: number, shell: ShellInfo): Promise<ShellExecResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(shell.command, [...shell.prefixArgs, fullCommand], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid ?? -1);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: capOutput(stdout),
        stderr: capOutput(stderr + (timedOut ? `\n[process killed after ${timeoutMs / 1000}s timeout]` : "")),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: capOutput(String(e)), durationMs: Date.now() - started });
    });
  });
}

// ── Background execution — NODE-managed (cross-platform) ──────
// The trailing "&" is stripped; we spawn the process ourselves as
// detached, tee stdout+stderr into a log file (capped at 512KB),
// and return the REAL child pid. Identical behavior on Linux,
// macOS and Windows — no bash $! tricks, no platform branches.
async function runBackground(inner: string, shell: ShellInfo): Promise<ShellExecResult> {
  await ensureWorkspace();
  const stamp = Date.now();
  const logAbs = path.join(SHELL_LOG_DIR, `bg-${stamp}.log`);
  const logRel = `.agent-shell/bg-${stamp}.log`;
  const started = Date.now();

  const child = spawn(shell.command, [...shell.prefixArgs, inner], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Tee output into the log file with a hard cap
  const logStream = fsSync.createWriteStream(logAbs);
  let logged = 0;
  const cap = 512 * 1024;
  const onData = (d: Buffer) => {
    if (logged < cap) {
      const slice = d.subarray(0, cap - logged);
      logStream.write(slice);
      logged += slice.length;
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("close", () => logStream.end());
  child.on("error", () => logStream.end());

  // Detach so the agent loop continues; the log stream keeps
  // capturing output in the background of the server process.
  child.unref();

  return {
    exitCode: 0,
    stdout: `background process started${child.pid ? ` (pid ${child.pid})` : ""}`,
    stderr: "",
    durationMs: Date.now() - started,
    background: true,
    pid: child.pid ?? undefined,
    logFile: logRel,
  };
}

// ═════════════════════════════════════════════════════════════
// Tool: workspace_info — environment + resources awareness
// ═════════════════════════════════════════════════════════════

async function countFiles(dir: string, cap = 5000): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<void> => {
    if (n >= cap) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".agent-shell") continue;
      if (n >= cap) return;
      if (e.isDirectory()) await walk(path.join(d, e.name));
      else n++;
    }
  };
  await walk(dir);
  return n;
}

const workspaceInfo: ToolDef = {
  name: "workspace_info",
  description:
    "Get the coding workspace environment: sandbox root path, file count, shell dialect available (bash or cmd), and the machine's real resources (CPU cores, total/free RAM, platform) so you can size builds and pick command syntax appropriately. The agent builds apps here using the host's CPU and memory.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const shell = await detectShell();
    let exists = true;
    try {
      await fs.access(WORKSPACE_ROOT);
    } catch {
      exists = false;
    }
    return {
      workspaceRoot: WORKSPACE_ROOT,
      exists,
      files: exists ? await countFiles(WORKSPACE_ROOT) : 0,
      shell: { kind: shell.kind, label: shell.label },
      system: {
        platform: `${os.platform()} ${os.release()} (${os.arch()})`,
        cpuCores: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        totalMemoryMB: Math.round(os.totalmem() / 1048576),
        freeMemoryMB: Math.round(os.freemem() / 1048576),
        uptimeHours: Math.round(os.uptime() / 360) / 10,
        nodeVersion: process.versions.node,
      },
      note: "All file and shell tools are sandboxed to workspaceRoot. Use relative paths from there. Check shell.kind — if it is cmd, prefer Windows syntax (dir/type/copy) or simple node/npm/python commands.",
    };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_list
// ═════════════════════════════════════════════════════════════

const fsList: ToolDef = {
  name: "fs_list",
  description:
    "List a directory inside the workspace (relative path, '.' = workspace root). Returns names, types, sizes, and modified times. Use it to explore a project before editing, exactly like the file explorer in VS Code.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative directory path, e.g. '.' or 'my-app/src'" },
    },
  },
  execute: async (args) => {
    const abs = sandboxResolve(String(args.path ?? "."));
    await assertInsideWorkspace(abs);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out: Array<{ name: string; type: string; bytes: number; modified?: string }> = [];
    for (const e of entries.slice(0, 500)) {
      const full = path.join(abs, e.name);
      let size = 0;
      let mtime: string | undefined;
      try {
        const st = await fs.stat(full);
        size = st.size;
        mtime = st.mtime.toISOString().slice(0, 19).replace("T", " ");
      } catch {
        /* broken symlink etc. */
      }
      out.push({ name: e.name, type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "link" : "file", bytes: size, modified: mtime });
    }
    return { path: String(args.path ?? "."), count: out.length, truncated: entries.length > 500, entries: out };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_read — with Claude-Code-style offset/limit lines
// ═════════════════════════════════════════════════════════════

const fsRead: ToolDef = {
  name: "fs_read",
  description:
    "Read a text file inside the workspace (relative path), with optional line window (offset + limit) like Claude Code's Read. Returns content with line numbers plus byte caps. Read source files before modifying them, and read logs (e.g. .agent-shell/bg-*.log written by background commands) to debug.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path, e.g. 'my-app/server.js'" },
      offset: { type: "number", description: "1-based line number to start reading from (optional)" },
      limit: { type: "number", description: "Number of lines to read (optional, default all up to byte cap)" },
      max_bytes: { type: "number", description: "Max bytes to return (default 131072, max 262144)" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const abs = sandboxResolve(String(args.path ?? ""));
    await assertInsideWorkspace(abs);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return { error: `file not found: ${args.path}` };
    }
    if (!st.isFile()) return { error: `"${args.path}" is not a regular file` };
    if (await isBinary(abs)) {
      return { error: `"${args.path}" looks binary — shell_run can inspect it instead` };
    }
    const raw = await fs.readFile(abs, "utf8");
    const allLines = raw.split("\n");
    const offset = Math.max(Math.floor(Number(args.offset) || 0), 0);
    const limit = Math.max(Math.floor(Number(args.limit) || 0), 0);
    let text = raw;
    let startLine = 1;
    if (offset || limit) {
      startLine = offset ? Math.min(offset, allLines.length) : 1;
      const end = limit ? Math.min(startLine + limit - 1, allLines.length) : allLines.length;
      text = allLines.slice(startLine - 1, end).join("\n");
    }
    const wantMax = Math.min(Math.max(Number(args.max_bytes) || 131072, 1024), 262144);
    let truncated = false;
    if (Buffer.byteLength(text) > wantMax) {
      text = text.slice(0, wantMax);
      truncated = true;
    }
    const numbered = text
      .split("\n")
      .map((l, i) => `${String(startLine + i).padStart(5, "| ")} ${l}`)
      .join("\n");
    return {
      path: String(args.path),
      bytes: st.size,
      totalLines: allLines.length,
      startLine,
      truncated: truncated || offset + (limit || Infinity) < allLines.length,
      content: numbered,
    };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_write
// ═════════════════════════════════════════════════════════════

const fsWrite: ToolDef = {
  name: "fs_write",
  description:
    "Write a file inside the workspace with full content (creates parent folders automatically). This is how you create source code, configs, and docs. Overwrites existing files — for targeted changes to a large file prefer fs_edit (search/replace) instead of rewriting the whole file. Max 512KB per call; split bigger files into multiple writes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path, e.g. 'my-app/index.html'" },
      content: { type: "string", description: "Full file content to write (max 512KB)" },
    },
    required: ["path", "content"],
  },
  execute: async (args) => {
    const rel = String(args.path ?? "").trim();
    const content = String(args.content ?? "");
    if (!rel) return { error: "path is required" };
    if (Buffer.byteLength(content) > 512 * 1024) {
      return { error: "content exceeds 512KB — split the file or write it in parts" };
    }
    const abs = sandboxResolve(rel);
    await assertInsideWorkspace(path.dirname(abs));
    let existed = false;
    try {
      await fs.access(abs);
      existed = true;
    } catch {
      /* new file */
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    publishPreviewWrite(rel); // v4.7 — webviews refresh the instant this lands
    return { path: rel, bytes: Buffer.byteLength(content), created: !existed };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_edit — Claude Code's Edit (exact search/replace)
// ═════════════════════════════════════════════════════════════

const fsEdit: ToolDef = {
  name: "fs_edit",
  description:
    "Edit a file by exact search/replace (Claude Code's Edit tool). Finds old_string in the file and replaces it with new_string. old_string must appear EXACTLY ONCE unless replace_all is true — include surrounding context lines to make it unique. PREFERRED over fs_write for modifying existing files: smaller payloads, no risk of losing the rest of the file, and shows a diff. Use replace_all for renames that touch many lines (e.g. changing a variable name). Use empty new_string to delete.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative file path inside the workspace" },
      old_string: { type: "string", description: "Exact text to find (must be unique unless replace_all)" },
      new_string: { type: "string", description: "Replacement text (empty string deletes the match)" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)" },
    },
    required: ["path", "old_string"],
  },
  execute: async (args) => {
    const rel = String(args.path ?? "").trim();
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    const replaceAll = Boolean(args.replace_all);
    if (!rel) return { error: "path is required" };
    if (oldStr === "") return { error: "old_string is required (must be non-empty)" };

    const abs = sandboxResolve(rel);
    await assertInsideWorkspace(abs);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      return { error: `file not found: ${rel}` };
    }
    if (!st.isFile()) return { error: `"${rel}" is not a regular file` };
    if (st.size > 1024 * 1024) return { error: `"${rel}" is larger than 1MB — use shell tools to edit it` };

    const content = await fs.readFile(abs, "utf8");
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      return {
        error: `old_string not found in ${rel}. Read the file (fs_read) to see its exact current content — whitespace and indentation must match exactly.`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        error: `old_string appears ${occurrences} times in ${rel}. Add surrounding context lines to make it unique, or set replace_all=true to replace all ${occurrences} occurrences.`,
      };
    }

    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);

    // Simple unified-diff-ish summary: show the replaced hunks
    const diffPreview = oldStr
      .split("\n")
      .slice(0, 8)
      .map((l) => `- ${l.slice(0, 120)}`)
      .join("\n") + "\n" + newStr
      .split("\n")
      .slice(0, 8)
      .map((l) => `+ ${l.slice(0, 120)}`)
      .join("\n");

    await fs.writeFile(abs, updated, "utf8");
    publishPreviewWrite(rel); // v4.7 — live preview refresh
    return {
      path: rel,
      occurrences: replaceAll ? occurrences : 1,
      bytesBefore: st.size,
      bytesAfter: Buffer.byteLength(updated),
      diffPreview: diffPreview.slice(0, 1500),
    };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_copy / fs_move
// ═════════════════════════════════════════════════════════════

const fsCopy: ToolDef = {
  name: "fs_copy",
  description: "Copy a file or folder (recursive) inside the workspace to a new relative path. Parent folders of the destination are created automatically.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Relative source path" },
      to: { type: "string", description: "Relative destination path" },
    },
    required: ["from", "to"],
  },
  execute: async (args) => {
    const fromRel = String(args.from ?? "").trim();
    const toRel = String(args.to ?? "").trim();
    if (!fromRel || !toRel) return { error: "from and to are required" };
    if (fromRel === toRel) return { error: "from and to are identical" };
    const fromAbs = sandboxResolve(fromRel);
    const toAbs = sandboxResolve(toRel);
    await assertInsideWorkspace(fromAbs);
    await assertInsideWorkspace(path.dirname(toAbs));
    try {
      await fs.cp(fromAbs, toAbs, { recursive: true });
    } catch (e) {
      return { error: `copy failed: ${(e as Error).message}` };
    }
    publishPreviewWrite(toRel); // v4.7 — live preview refresh
    return { from: fromRel, to: toRel, copied: true };
  },
};

const fsMove: ToolDef = {
  name: "fs_move",
  description: "Move or rename a file or folder inside the workspace to a new relative path (like mv). Parent folders of the destination are created automatically.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Relative source path" },
      to: { type: "string", description: "Relative destination path" },
    },
    required: ["from", "to"],
  },
  execute: async (args) => {
    const fromRel = String(args.from ?? "").trim();
    const toRel = String(args.to ?? "").trim();
    if (!fromRel || !toRel) return { error: "from and to are required" };
    if (fromRel === toRel) return { error: "from and to are identical" };
    const fromAbs = sandboxResolve(fromRel);
    const toAbs = sandboxResolve(toRel);
    await assertInsideWorkspace(fromAbs);
    await assertInsideWorkspace(path.dirname(toAbs));
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await fs.rename(fromAbs, toAbs);
    } catch (e) {
      return { error: `move failed: ${(e as Error).message}` };
    }
    publishPreviewWrite(toRel); // v4.7 — live preview refresh
    return { from: fromRel, to: toRel, moved: true };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_mkdir
// ═════════════════════════════════════════════════════════════

const fsMkdir: ToolDef = {
  name: "fs_mkdir",
  description:
    "Create a folder (recursive) inside the workspace, e.g. 'my-app/src/components'. Safe to call on existing folders.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative folder path to create" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const rel = String(args.path ?? "").trim();
    if (!rel || rel === "." || rel === "./") return { error: "provide a folder name to create" };
    const abs = sandboxResolve(rel);
    await assertInsideWorkspace(path.dirname(abs));
    await fs.mkdir(abs, { recursive: true });
    return { path: rel, created: true };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_delete
// ═════════════════════════════════════════════════════════════

const fsDelete: ToolDef = {
  name: "fs_delete",
  description:
    "Delete a file or folder (recursive) INSIDE the workspace only. Use to clean up failed builds or scratch files. Cannot touch anything outside the sandbox.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative path to delete" },
    },
    required: ["path"],
  },
  execute: async (args) => {
    const rel = String(args.path ?? "").trim();
    if (!rel || rel === "." || rel === "./") return { error: "refusing to delete the workspace root" };
    const abs = sandboxResolve(rel);
    await assertInsideWorkspace(abs);
    try {
      await fs.access(abs);
    } catch {
      return { error: `not found: ${rel}` };
    }
    await fs.rm(abs, { recursive: true, force: true });
    return { path: rel, deleted: true };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_search — case-insensitive substring (kept for
// compatibility; fs_grep is the regex superset)
// ═════════════════════════════════════════════════════════════

const fsSearch: ToolDef = {
  name: "fs_search",
  description:
    "Search the workspace for a case-insensitive substring in file contents and file names (like VS Code's global search). For regex or case-sensitive search use fs_grep instead. Skips node_modules/.git. Returns file, line number, and the matching line.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Text to search for (case-insensitive)" },
      path: { type: "string", description: "Optional relative folder to restrict the search to" },
      max_results: { type: "number", description: "Max matches (default 50)" },
    },
    required: ["pattern"],
  },
  execute: async (args) => {
    const needle = String(args.pattern ?? "").toLowerCase();
    if (!needle) return { error: "pattern is required" };
    const root = sandboxResolve(String(args.path ?? "."));
    await assertInsideWorkspace(root);
    const max = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    let scanned = 0;
    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= max || scanned > 4000) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= max) return;
        const full = path.join(dir, e.name);
        const rel = path.relative(WORKSPACE_ROOT, full);
        if (e.isDirectory()) {
          if (["node_modules", ".git", ".agent-shell"].includes(e.name)) continue;
          await walk(full);
        } else if (e.isFile()) {
          scanned++;
          if (e.name.toLowerCase().includes(needle)) {
            matches.push({ file: rel, line: 0, text: "(filename match)" });
            continue;
          }
          if (e.name.endsWith(".log") && e.name.startsWith("bg-")) continue; // shell logs get big
          try {
            if (await isBinary(full)) continue;
            const st = await fs.stat(full);
            if (st.size > 1024 * 1024) continue;
            const text = await fs.readFile(full, "utf8");
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && matches.length < max; i++) {
              if (lines[i].toLowerCase().includes(needle)) {
                matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
              }
            }
          } catch {
            /* unreadable */
          }
        }
      }
    };
    await walk(root);
    return { pattern: String(args.pattern), matches: matches.length, scannedFiles: scanned, results: matches };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_glob — Claude Code's Glob (pattern file finder)
// ═════════════════════════════════════════════════════════════

/** Convert a glob pattern to a RegExp anchored to the relative path. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** — any chars incl. separators
        re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 3 : 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const body = pattern.slice(i + 1, end).split(",").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${body})`;
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end > i) {
        re += pattern.slice(i, end + 1).replace(/\\/g, "\\\\");
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`, "i");
}

const fsGlob: ToolDef = {
  name: "fs_glob",
  description:
    "Find files by glob pattern (Claude Code's Glob). Patterns: ** = any depth, * = one segment, ? = one char, {a,b} = alternatives. Examples: '**/*.py', 'src/**/*.tsx', 'my-app/*.{js,json}'. Returns matching relative paths with sizes — much faster than listing recursively.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. '**/*.py' or 'my-app/src/**/*.{ts,tsx}'" },
      path: { type: "string", description: "Optional relative folder to search in (default workspace root)" },
    },
    required: ["pattern"],
  },
  execute: async (args) => {
    const pattern = String(args.pattern ?? "").trim();
    if (!pattern) return { error: "pattern is required" };
    const root = sandboxResolve(String(args.path ?? "."));
    await assertInsideWorkspace(root);
    let re: RegExp;
    try {
      re = globToRegExp(pattern);
    } catch {
      return { error: `invalid glob pattern: ${pattern}` };
    }
    const matches: Array<{ file: string; bytes: number }> = [];
    const walk = async (dir: string): Promise<void> => {
      if (matches.length >= 500) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (matches.length >= 500) return;
        const full = path.join(dir, e.name);
        const rel = path.relative(root, full);
        if (e.isDirectory()) {
          if (["node_modules", ".git", ".agent-shell"].includes(e.name)) continue;
          await walk(full);
        } else if (e.isFile()) {
          if (re.test(rel) || re.test(rel.split(path.sep).join("/"))) {
            let bytes = 0;
            try {
              bytes = (await fs.stat(full)).size;
            } catch {
              /* skip */
            }
            matches.push({ file: rel, bytes });
          }
        }
      }
    };
    await walk(root);
    return { pattern, root: String(args.path ?? "."), matches: matches.length, files: matches.slice(0, 500) };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_grep — Claude Code's Grep (regex content search)
// ═════════════════════════════════════════════════════════════

const fsGrep: ToolDef = {
  name: "fs_grep",
  description:
    "Search file CONTENTS with a regular expression (Claude Code's Grep / ripgrep-style). Case-sensitive by default — set case_insensitive=true for /i. Returns file, 1-based line number, and the matching line. Skips node_modules/.git, binaries and files over 1MB. Use this for precise lookups (function definitions, imports, TODOs); use fs_search for plain substring.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (JS syntax), e.g. 'function\\\\s+\\\\w+\\\\(' or 'TODO|FIXME'" },
      path: { type: "string", description: "Optional relative folder or single file to restrict the search to" },
      case_insensitive: { type: "boolean", description: "Case-insensitive matching (default false)" },
      max_results: { type: "number", description: "Max matches (default 50, max 200)" },
    },
    required: ["pattern"],
  },
  execute: async (args) => {
    const raw = String(args.pattern ?? "");
    if (!raw) return { error: "pattern is required" };
    let re: RegExp;
    try {
      re = new RegExp(raw, args.case_insensitive ? "i" : "");
    } catch (e) {
      return { error: `invalid regex: ${(e as Error).message}` };
    }
    const target = sandboxResolve(String(args.path ?? "."));
    await assertInsideWorkspace(target);
    const max = Math.min(Math.max(Number(args.max_results) || 50, 1), 200);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    let scanned = 0;

    const scanFile = async (abs: string, rel: string) => {
      scanned++;
      if (matches.length >= max) return;
      try {
        if (await isBinary(abs)) return;
        const st = await fs.stat(abs);
        if (st.size > 1024 * 1024) return;
        const lines = (await fs.readFile(abs, "utf8")).split("\n");
        for (let i = 0; i < lines.length && matches.length < max; i++) {
          if (re.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      } catch {
        /* unreadable */
      }
    };

    let st;
    try {
      st = await fs.stat(target);
    } catch {
      return { error: `path not found: ${args.path}` };
    }
    if (st.isFile()) {
      await scanFile(target, String(args.path));
    } else {
      const walk = async (dir: string): Promise<void> => {
        if (matches.length >= max || scanned > 4000) return;
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (matches.length >= max) return;
          const full = path.join(dir, e.name);
          const rel = path.relative(WORKSPACE_ROOT, full);
          if (e.isDirectory()) {
            if (["node_modules", ".git", ".agent-shell"].includes(e.name)) continue;
            await walk(full);
          } else if (e.isFile() && !(e.name.startsWith("bg-") && e.name.endsWith(".log"))) {
            await scanFile(full, rel);
          }
        }
      };
      await walk(target);
    }
    return { pattern: raw, matches: matches.length, scannedFiles: scanned, results: matches };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: fs_tree — directory tree (like the tree command)
// ═════════════════════════════════════════════════════════════

const fsTree: ToolDef = {
  name: "fs_tree",
  description:
    "Show a directory tree of a workspace folder (like the tree command) with file sizes — the fastest way to see a project's structure. Skips node_modules/.git. Depth-limited (default 4).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative folder (default '.')" },
      depth: { type: "number", description: "Max depth (default 4, max 8)" },
    },
  },
  execute: async (args) => {
    const root = sandboxResolve(String(args.path ?? "."));
    await assertInsideWorkspace(root);
    const maxDepth = Math.min(Math.max(Math.floor(Number(args.depth) || 4), 1), 8);
    const lines: string[] = [String(args.path ?? ".")];
    let count = 0;
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > maxDepth || count > 400) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const visible = entries.filter((e) => !["node_modules", ".git", ".agent-shell"].includes(e.name));
      for (let i = 0; i < visible.length; i++) {
        if (count > 400) return;
        const e = visible[i];
        const last = i === visible.length - 1;
        const branch = last ? "└── " : "├── ";
        let label = e.name;
        if (e.isFile()) {
          try {
            const st = await fs.stat(path.join(dir, e.name));
            label += `  (${st.size}B)`;
          } catch {
            /* skip */
          }
          count++;
          lines.push(`${prefix}${branch}${label}`);
        } else if (e.isDirectory()) {
          count++;
          lines.push(`${prefix}${branch}${label}/`);
          await walk(path.join(dir, e.name), prefix + (last ? "    " : "│   "), depth + 1);
        }
      }
    };
    await walk(root, "", 1);
    return { tree: lines.join("\n"), entries: count, truncated: count > 400 };
  },
};

// ═════════════════════════════════════════════════════════════
// Tools: todo_write / todo_read — Claude Code's TodoWrite
// ═════════════════════════════════════════════════════════════

export interface AgentTodo {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

async function readTodos(): Promise<AgentTodo[]> {
  try {
    const raw = await fs.readFile(TODOS_FILE, "utf8");
    const parsed = JSON.parse(raw) as AgentTodo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeTodos(todos: AgentTodo[]): Promise<void> {
  await ensureWorkspace();
  await fs.writeFile(TODOS_FILE, JSON.stringify(todos, null, 2), "utf8");
}

const todoWrite: ToolDef = {
  name: "todo_write",
  description:
    "Create or update the build PLAN (Claude Code's TodoWrite). Call it at the START of every non-trivial build with the full step list, and UPDATE statuses as you progress (pending → in_progress → completed). This keeps long builds on track and gives the user live progress. Replace the whole list each call. Keep 3-8 focused items.",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The full todo list (replaces the previous one)",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "What to do, e.g. 'Scaffold project folder + files'" },
            status: { type: "string", description: "pending | in_progress | completed", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  execute: async (args) => {
    const raw = args.todos;
    if (!Array.isArray(raw) || raw.length === 0) return { error: "todos must be a non-empty array" };
    if (raw.length > 12) return { error: "too many todos (max 12) — keep the plan focused" };
    const todos: AgentTodo[] = raw.map((t) => {
      const obj = (t ?? {}) as Record<string, unknown>;
      const status = String(obj.status);
      return {
        content: String(obj.content ?? "").slice(0, 200),
        status: status === "in_progress" ? "in_progress" : status === "completed" ? "completed" : "pending",
      };
    });
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) return { error: "only one todo may be in_progress at a time (Claude Code rule — pick the current step)" };
    await writeTodos(todos);
    return {
      todos,
      summary: `${todos.filter((t) => t.status === "completed").length}/${todos.length} done`,
    };
  },
};

const todoRead: ToolDef = {
  name: "todo_read",
  description: "Read the current build plan/todo list (Claude Code's TodoRead). Use at the start of a CONTINUATION run to see what the previous session left pending.",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const todos = await readTodos();
    return { todos, summary: todos.length ? `${todos.filter((t) => t.status === "completed").length}/${todos.length} done` : "no plan yet" };
  },
};

// ═════════════════════════════════════════════════════════════
// Tool: shell_run — guarded command execution
// ═════════════════════════════════════════════════════════════

const shellRun: ToolDef = {
  name: "shell_run",
  description: `Run a shell command in the workspace (cwd = workspace root) with real CPU/memory of the host. For builds, installs, tests, and running/verifying apps. Works on Linux, macOS and Windows (bash if available, else cmd.exe with automatic translation of common bash commands).

RULES:
- Use relative paths — absolute paths, "..", "~" and $HOME are blocked (sandbox).
- Allowed commands: node/bun/npm/npx/python/pip/git/tsc/pytest, file ops (ls/dir cat type copy move del mkdir tar), curl/wget, ps, kill <pid>, taskkill.
- Background long-running processes (servers): end the command with "&" — the tool spawns it detached and returns a REAL pid plus a log file (fs_read the logFile to watch output, e.g. .agent-shell/bg-*.log).
- Stop a background process with: kill <pid> (unix) — on Windows use: taskkill /pid <pid> /T /F.
- Default timeout 60s (max 300s) — foreground commands are killed at the timeout.
- To check a server responds: curl http://localhost:<port>/
- Check shell.kind from workspace_info: if it says cmd.exe, prefer Windows syntax (dir, type, copy) or simple node/npm/python commands.`,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run (bash or cmd syntax)" },
      timeout_seconds: { type: "number", description: "Foreground timeout in seconds (default 60, max 300)" },
    },
    required: ["command"],
  },
  execute: async (args) => {
    const command = String(args.command ?? "").trim();
    // extra shell-specific rate limit on top of the generic tool limit
    const rl = rateLimit("shell");
    if (!rl.allowed) {
      return { error: `shell rate limit reached (${rl.retryAfterMs}ms backoff) — wait and retry` };
    }

    const shell = await detectShell();
    await ensureWorkspace();
    const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 60, 5), 300);

    // Background execution: trailing "&" — Node-managed detached spawn
    // (cross-platform: works with bash AND cmd, and gives a real pid)
    if (/\s*&\s*$/.test(command)) {
      const inner = command.replace(/\s*&\s*$/, "").trim();
      const v = validateCommand(inner, shell.kind);
      if (!v.ok) return { error: v.error };
      const translated = shell.kind === "cmd" ? translateForCmd(inner) : inner;
      const res = await runBackground(translated, shell);
      return {
        background: true,
        pid: res.pid ?? null,
        logFile: res.logFile ?? null,
        exitCode: res.exitCode,
        stdout: res.stdout,
        shell: shell.kind,
        note: "process runs in the background — fs_read the logFile to watch output; verify with curl; stop with kill <pid> (unix) or taskkill /pid <pid> /T /F (Windows)",
      };
    }

    const v = validateCommand(command, shell.kind);
    if (!v.ok) return { error: v.error };
    const finalCommand = shell.kind === "cmd" ? translateForCmd(command) : command;
    const res = await runShell(finalCommand, timeoutSec * 1000, shell);
    return {
      background: false,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.durationMs,
      timedOut: Boolean(res.timedOut),
      shell: shell.kind,
    };
  },
};

// ═══════════════════════════════════════════════════════════
// Tool: fs_batch — v4.0 TURBO: one round = a whole scaffold.
// The #1 speed fix: the v3 loop burned one full LLM ROUND (with
// reasoning tokens) per fs_mkdir — “app”, “app/templates”,
// “app/static/css” = 3 rounds = 3× the latency. fs_batch does all
// of it in ONE call: mkdir every folder, write several complete
// files, delete scratch — each op reported individually.
// ═══════════════════════════════════════════════════════════

const fsBatch: ToolDef = {
  name: "fs_batch",
  description: `Execute MANY filesystem operations in ONE call — the FASTEST way to build (create all folders + write several complete files together). ops is an ordered array of {op: 'mkdir'|'write'|'delete', path, content} and every op reports its own result.
WHEN TO USE: scaffolding a project (all directories + first files in one shot), writing 2+ related files, or cleanup. Prefer this over repeated fs_mkdir/fs_write whenever you plan 2+ operations — each saved round is seconds of latency and tokens. Limits: 50 ops, 512KB per write, 2MB per batch.`,
  parameters: {
    type: "object",
    properties: {
      ops: {
        type: "array",
        description: "Ordered operations, executed in sequence (max 50 — enforced at runtime)",
        items: {
          type: "object",
          properties: {
            op: { type: "string", enum: ["mkdir", "write", "delete"], description: "Operation kind" },
            path: { type: "string", description: "Relative path inside the workspace" },
            content: { type: "string", description: "FULL file content for op='write' — complete files, never placeholders" },
          },
          required: ["op", "path"],
        },
      },
    },
    required: ["ops"],
  },
  execute: async (args) => {
    const raw = Array.isArray(args.ops) ? (args.ops as Array<Record<string, unknown>>) : [];
    if (raw.length === 0) return { error: "ops array is required" };
    if (raw.length > 50) return { error: `${raw.length} ops exceeds the 50-op limit — split into multiple fs_batch calls` };
    await ensureWorkspace();
    const results: Array<{ op: string; path: string; ok: boolean; bytes?: number; created?: boolean; error?: string }> = [];
    let createdDirs = 0;
    let writtenFiles = 0;
    let deleted = 0;
    let failed = 0;
    let totalBytes = 0;
    for (const o of raw) {
      const op = String(o.op ?? "");
      const rel = String(o.path ?? "").trim();
      if (!rel || rel === "." || rel === "./" || !op) {
        failed++;
        results.push({ op, path: rel, ok: false, error: "op and path are required" });
        continue;
      }
      const content = typeof o.content === "string" ? o.content : "";
      try {
        if (op === "mkdir") {
          const abs = sandboxResolve(rel);
          await assertInsideWorkspace(path.dirname(abs));
          await fs.mkdir(abs, { recursive: true });
          createdDirs++;
          results.push({ op, path: rel, ok: true });
        } else if (op === "write") {
          const b = Buffer.byteLength(content);
          if (b > 512 * 1024) throw new Error("content exceeds 512KB — split the file");
          totalBytes += b;
          if (totalBytes > 2 * 1024 * 1024) throw new Error("batch total exceeds 2MB — split into multiple fs_batch calls");
          const abs = sandboxResolve(rel);
          await assertInsideWorkspace(path.dirname(abs));
          let existed = false;
          try {
            await fs.access(abs);
            existed = true;
          } catch {
            /* new file */
          }
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, "utf8");
          publishPreviewWrite(rel); // v4.7 — live preview refresh
          writtenFiles++;
          results.push({ op, path: rel, ok: true, bytes: b, created: !existed });
        } else if (op === "delete") {
          const abs = sandboxResolve(rel);
          await assertInsideWorkspace(abs);
          await fs.rm(abs, { recursive: true, force: true });
          deleted++;
          results.push({ op, path: rel, ok: true });
        } else {
          throw new Error(`unknown op "${op}"`);
        }
      } catch (e) {
        failed++;
        results.push({ op, path: rel, ok: false, error: (e as Error).message });
      }
    }
    return {
      ops: raw.length,
      ok: failed === 0,
      createdDirs,
      writtenFiles,
      deleted,
      bytes: totalBytes,
      failed,
      ...(failed > 0 ? { failures: results.filter((r) => !r.ok) } : {}),
      results,
    };
  },
};

// ── Registry ─────────────────────────────────────────────────
export const CODING_TOOLS: ToolDef[] = [
  workspaceInfo,
  fsList,
  fsRead,
  fsWrite,
  fsBatch,
  fsEdit,
  fsCopy,
  fsMove,
  fsMkdir,
  fsDelete,
  fsSearch,
  fsGlob,
  fsGrep,
  fsTree,
  todoWrite,
  todoRead,
  shellRun,
];

// v4.0 TURBO — parallel execution sets (openclaude partitionToolCalls
// pattern): consecutive READ-ONLY tool calls from one model turn run
// CONCURRENTLY (cap PARALLEL_TOOL_LIMIT); anything that mutates the
// workspace or spawns processes stays strictly serial. Read-only
// tools cannot interfere with each other, so latency stacks instead
// of adding up.
export const READ_ONLY_TOOLS = new Set([
  "workspace_info",
  "fs_list",
  "fs_read",
  "fs_search",
  "fs_glob",
  "fs_grep",
  "fs_tree",
  "todo_read",
]);
export const PARALLEL_TOOL_LIMIT = 6;

export async function executeCodingTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = CODING_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown coding tool: ${name}` };
  try {
    return await tool.execute(args ?? {});
  } catch (e) {
    return { error: `tool ${name} failed: ${(e as Error).message}` };
  }
}

export const CODING_TOOL_NAMES = CODING_TOOLS.map((t) => t.name);

