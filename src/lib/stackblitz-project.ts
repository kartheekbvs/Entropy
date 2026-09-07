// ─────────────────────────────────────────────────────────────
// v4.8 STACKBLITZ PROJECT ANALYZER — "the AI reads the README
// and runs the app."
//
// The v4.7 Live Preview Studio could only serve static HTML the
// agent wrote. The user's ask (verbatim intent): "this is basic —
// it only gives html files, not applicable to all. Use the
// StackBlitz SDK for preview, the AI can run it automatically by
// seeing the README — this one is perfect in real time."
//
// So this module turns WHATEVER the agent built — Express
// servers, Vite/React apps, Vue, Angular, plain HTML+JS pages,
// even mixed FastAPI+frontend projects — into a ready-to-run
// StackBlitz project:
//
//   • detects the project root (package.json wins; HTML or Python
//     roots follow), newest agent work first
//   • READS the README (and AGENT.md) exactly like a developer
//     would: title, description, and every run command
//     (`npm install`, `npm run dev`, `uvicorn … --port 4500` …)
//   • routes to the right StackBlitz template — `node` for
//     WebContainers (npm install + start script auto-run + a real
//     in-browser terminal), EngineBlock templates for static pages
//   • injects the `stackblitz: { installDependencies, startCommand }`
//     key into package.json so dependencies install and the app
//     STARTS ITSELF the moment the embed boots
//   • bounds the payload (files / bytes / binary skip) so an
//     embed never chokes on a huge workspace
//
// Pure data + injected async reader → the API route feeds it real
// fs reads; tests can feed it strings. Zero client dependencies.
// ─────────────────────────────────────────────────────────────

// ── Public types ─────────────────────────────────────────────

/** Valid StackBlitz SDK templates (mirrors @stackblitz/sdk types). */
export type SBTemplate =
  | "node" // WebContainers: npm install + terminal + dev server
  | "javascript" // EngineBlock: static pages / CDN apps
  | "typescript" // EngineBlock: in-browser TS compile
  | "create-react-app" // EngineBlock: react-scripts
  | "angular-cli" // EngineBlock: Angular CLI
  | "vue" // EngineBlock: Vue (v2 style)
  | "polymer"
  | "html";

export type SBEngine = "webcontainers" | "engineblock";

/** Reads one workspace-relative text file; null = skip (binary, unreadable). */
export type ProjectFileReader = (rel: string) => Promise<string | null>;

export interface SBProjectPayload {
  /** Exact `Project` object for sdk.embedProject / sdk.openProject. */
  title: string;
  description?: string;
  template: SBTemplate;
  files: Record<string, string>;
  settings?: { compile: { trigger: "auto" | "keystroke" | "save"; clearConsole: boolean } };
  /** EngineBlock-only npm deps (from package.json when template ≠ node). */
  dependencies?: Record<string, string>;
}

export interface SBMeta {
  root: string;
  title: string;
  template: SBTemplate | null;
  engine: SBEngine | null;
  /** npm script name the embed auto-runs (WebContainers only). */
  startScript: string | null;
  /** Human-readable run command, e.g. "npm run dev". */
  startCommand: string | null;
  /** File the embed opens in its editor. */
  openFile: string | null;
  fileCount: number;
  totalBytes: number;
  /** Files skipped (binary / too large / lockfile) — capped for the UI. */
  skipped: string[];
  warnings: string[];
  /** Run commands the analyzer READ out of README/AGENT.md. */
  readmeCommands: string[];
  /** Where the run command came from — "the AI read the README". */
  detectedFrom: "package.json" | "readme" | "html" | "python" | null;
  stackSummary: string[];
  /** Non-JS backend found next to a static frontend (run locally). */
  companionBackend: { kind: string; runCommand: string } | null;
  /** Best static page to fall back to when StackBlitz can't run the stack. */
  fallbackHtmlEntry: string | null;
  signature: string;
  analyzedAt: number;
}

export interface SBAnalysis {
  mode: "stackblitz" | "local" | "none";
  project: SBProjectPayload | null;
  meta: SBMeta | null;
  /** feed version stamp (route sets it; cache stores the versioned feed) */
  v?: string;
}

// ── Lightweight tree node (mirrors /api/workspace/tree) ──────

interface LiteNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  children?: LiteNode[];
}

interface FlatFile {
  path: string; // workspace-relative POSIX
  size: number;
  mtime: number;
}

// ── Bounds (an embed must never choke) ───────────────────────

const MAX_FILES = 200;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SKIPPED_LISTED = 12;

/** Dirs never shipped to StackBlitz. */
const SHIP_IGNORE = new Set([
  "node_modules", ".git", ".agent-shell", ".agent-state", ".archive",
  ".next", "dist", "build", "out", "coverage", "__pycache__", ".pytest_cache",
  ".venv", "venv", "env", ".cache", ".turbo", ".idea", ".vscode", ".turbo",
  "target", "vendor", "tmp", ".DS_Store",
]);

/** Files never shipped (huge, binary, or secrets). */
const SKIP_BASENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  ".env", ".env.local", ".env.production", ".env.secrets",
]);
const SKIP_EXT = /\.(pkl|pickle|db|sqlite|sqlite3|pyc|pyo|wasm|zip|gz|tar|7z|rar|exe|dll|so|dylib|bin|dat|pt|onnx|h5|paddle|joblib|lockb|png|jpe?g|gif|webp|bmp|ico|avif|mp4|webm|mp3|wav|ogg|mov|pdf|woff2?|ttf|eot|otf|ipynb)$/i;

/** Text-ish extensions we are willing to read at all. */
const TEXT_EXT = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|env\.example|ts|tsx|js|jsx|mjs|cjs|cts|mts|html?|htm|css|scss|sass|less|vue|svelte|astro|py|pyi|sh|bash|zsh|bat|ps1|dockerfile|makefile|gitignore|gitattributes|editorconfig|npmrc|nvmrc|go|rs|java|kt|rb|php|c|h|cpp|hpp|cc|cs|swift|sql|graphql|gql|csv|tsv|svg|xml)$/i;
const TEXT_BASENAMES = /^(dockerfile|makefile|license|licence|readme|changelog|codeowners|procfile|gemfile|rakefile)$/i;
const TEXT_PREFIXES = /^(\.gitignore|\.gitattributes|\.dockerignore|\.editorconfig|\.env\.example|\.env\.sample|\.npmrc|\.nvmrc|\.prettier|\.eslint)/i;

function isShippable(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_BASENAMES.has(lower)) return false;
  if (SKIP_EXT.test(lower)) return false;
  return TEXT_EXT.test(lower) || TEXT_BASENAMES.test(lower) || TEXT_PREFIXES.test(lower);
}

// ── Signature (cheap change detection, tree-only) ────────────

/** FNV-1a 32-bit hex hash of sorted "path:size:mtime" lines. */
export function computeSignature(files: FlatFile[]): string {
  const lines = files
    .map((f) => `${f.path}:${f.size}:${Math.floor(f.mtime)}`)
    .sort();
  let h = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2f; // separator mix
  }
  return h.toString(16).padStart(8, "0");
}

// ── Tree helpers ─────────────────────────────────────────────

function flatten(nodes: LiteNode[]): FlatFile[] {
  const out: FlatFile[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as LiteNode;
    if (n.type === "file") {
      out.push({ path: n.path, size: n.size, mtime: n.mtime });
    } else if (n.children) {
      stack.push(...n.children);
    }
  }
  return out;
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

// ── README parsing — the "AI reads the README" brain ─────────

/**
 * Every shell-ish command a README mentions. Fenced blocks and
 * inline `code` both count. Capped at 12, deduped, order kept.
 */
export function extractReadmeCommands(markdown: string): string[] {
  const cmds: string[] = [];
  const seen = new Set<string>();
  const push = (c: string) => {
    const t = c.trim();
    if (!t || t.length > 160 || seen.has(t)) return;
    // keep only command-looking lines (starts with a known runner or $)
    if (!/^(?:\$\s*)?(?:npm|npx|yarn|pnpm|bun|node|python3?|pip3?|uv|uvicorn|gunicorn|flask|streamlit|make|docker|git|cd|export|PORT=|python3?\s+-m)/.test(t)) return;
    seen.add(t);
    cmds.push(t);
    if (cmds.length >= 12) return;
  };
  // fenced ```bash / ```sh / ``` blocks — line by line
  const fence = /```(?:bash|sh|shell|console|zsh)?\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(markdown)) !== null && cmds.length < 12) {
    for (const raw of m[1].split(/\r?\n/)) {
      const line = raw.replace(/^\s*\$\s*/, "").replace(/^#\s.*$/, "").trim();
      if (line) push(line);
      if (cmds.length >= 12) break;
    }
  }
  // inline `code`
  const inline = /`([^`\n]{3,160})`/g;
  while ((m = inline.exec(markdown)) !== null && cmds.length < 12) {
    push(m[1]);
  }
  return cmds;
}

/** The npm script a README tells you to run ("npm run dev" → "dev"). */
function readmeScript(cmds: string[]): string | null {
  for (const c of cmds) {
    let m = /^npm\s+run\s+([\w:@.-]+)$/.exec(c);
    if (m) return m[1];
    m = /^(?:bun|yarn|pnpm)\s+(?:run\s+)?([\w:@.-]+)$/.exec(c);
    if (m && !["install", "i", "add"].includes(m[1])) return m[1];
    if (/^npm\s+start$/.test(c)) return "start";
  }
  return null;
}

/** Node entry the README mentions ("node server.js"). */
function readmeNodeEntry(cmds: string[]): string | null {
  for (const c of cmds) {
    const m = /^node\s+([\w./@-]+\.(?:js|mjs|cjs|ts))$/.exec(c);
    if (m) return m[1];
  }
  return null;
}

/** Python run command (uvicorn / flask / streamlit / plain file). */
export function pythonRunCommand(cmds: string[], files: string[]): string | null {
  for (const c of cmds) {
    if (/^(?:python3?|uv)\s+[\w./-]+\.py\b/.test(c)) return c;
    if (/^uvicorn\s+[\w:.]+/.test(c)) return c;
    if (/^gunicorn\s+/.test(c)) return c;
    if (/^flask\s+--app\s+/.test(c) || /^flask\s+run$/.test(c)) return c;
    if (/^streamlit\s+run\s+/.test(c)) return c;
  }
  // derive from files: FastAPI app → uvicorn; else main/app.py
  const hasFastApi = files.some((f) => /^backend[\/\\]main\.py$/.test(f));
  const main = files.find((f) => /^(?:main|app|run|server|start)\.py$/.test(f));
  if (hasFastApi) return "python3 -m uvicorn backend.main:app --host 0.0.0.0 --port 4500";
  if (main) return `python3 ${main}`;
  return null;
}

/** Port a README/AGENT.md command mentions. */
function detectPort(cmds: string[]): number | null {
  for (const c of cmds) {
    let m = /--port[= ](\d{2,5})/.exec(c);
    if (m) return Number(m[1]);
    m = /port[=: ](\d{2,5})\b/.exec(c);
    if (m) return Number(m[1]);
  }
  return null;
}

// ── README metadata (title + description) ────────────────────

function readmeTitle(markdown: string): string | null {
  const m = /^#\s+(.{2,90})$/m.exec(markdown);
  return m ? m[1].replace(/[*_`]/g, "").trim() : null;
}

function readmeDescription(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let inCode = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line) || /^[|>\-]/.test(line)) continue;
    const text = line.replace(/[*_`[\]]/g, "").trim();
    if (text.length >= 24 && text.length <= 240) return text;
  }
  return null;
}

// ── Project-root detection ───────────────────────────────────

interface RootCandidate {
  root: string; // "" = workspace root
  kind: "node" | "html" | "python";
  files: FlatFile[]; // shippable files under it
  score: number;
}

function collectRoots(all: FlatFile[]): RootCandidate[] {
  // group shippable files by their top-level segment ("" = root level)
  const byDir = new Map<string, FlatFile[]>();
  for (const f of all) {
    if (!isShippable(f.path.slice(f.path.lastIndexOf("/") + 1))) continue;
    const top = f.path.includes("/") ? f.path.slice(0, f.path.indexOf("/")) : "";
    const arr = byDir.get(top);
    if (arr) arr.push(f);
    else byDir.set(top, [f]);
  }
  const candidates: RootCandidate[] = [];

  // 1. every dir (incl. workspace root "") with a package.json → node root.
  //    Nested package.json dirs deeper than depth 1 also count (apps/<x>/).
  const pkgRoots = new Set<string>();
  for (const f of all) {
    if (/^package\.json$/i.test(f.path.slice(f.path.lastIndexOf("/") + 1))) {
      const dir = dirOf(f.path);
      if (dir.split("/").length <= 2) pkgRoots.add(dir); // "" or "app" or "apps/x"
    }
  }
  for (const root of pkgRoots) {
    const files = all.filter((f) => (root === "" ? true : f.path.startsWith(root + "/")));
    const newest = files.reduce((a, b) => Math.max(a, b.mtime), 0);
    const shippable = files.filter((f) => isShippable(f.path.slice(f.path.lastIndexOf("/") + 1)));
    candidates.push({
      root,
      kind: "node",
      files: shippable,
      score: 1_000_000 + Math.min(shippable.length, 120) * 1000 + Math.floor(newest / 1000),
    });
  }

  // 2. python root — a dir whose level holds requirements/pyproject AND
  //    whose subtree holds ≥2 .py files (python projects keep backend/ +
  //    tests/ subdirs, so the marker is level-local but the py count recursive)
  for (const dir of byDir.keys()) {
    const levelFiles = byDir.get(dir) ?? [];
    const marker = levelFiles.some((f) =>
      /^(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|environment\.yml)$/i.test(
        f.path.slice(f.path.lastIndexOf("/") + 1)
      )
    );
    if (!marker) continue;
    const allUnder = all.filter((f) => (dir === "" ? true : f.path.startsWith(dir + "/")));
    const pyCount = allUnder.filter((f) => /\.py$/i.test(f.path)).length;
    if (pyCount < 2) continue;
    const shippable = allUnder.filter((f) => isShippable(f.path.slice(f.path.lastIndexOf("/") + 1)));
    candidates.push({
      root: dir,
      kind: "python",
      files: shippable,
      score: 100 + Math.min(pyCount, 80),
    });
  }

  // 3. html root (a dir containing index.html, no package.json needed)
  for (const [dir, files] of byDir) {
    if (pkgRoots.has(dir)) continue; // node root already covers it
    const hasIndex = files.some((f) => /^index\.html?$/i.test(f.path.slice(f.path.lastIndexOf("/") + 1)));
    if (hasIndex) {
      const allUnder = all.filter((f) => (dir === "" ? true : f.path.startsWith(dir + "/")));
      const shippable = allUnder.filter((f) => isShippable(f.path.slice(f.path.lastIndexOf("/") + 1)));
      const newest = shippable.reduce((a, b) => Math.max(a, b.mtime), 0);
      candidates.push({
        root: dir,
        kind: "html",
        files: shippable,
        score: 1 + Math.min(shippable.length, 60) + Math.floor(newest / 1_000_000),
      });
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

// ── package.json handling ────────────────────────────────────

interface ParsedPkg {
  raw: string;
  name?: string;
  description?: string;
  scripts: Record<string, string>;
  deps: Record<string, string>;
  devDeps: Record<string, string>;
  main?: string;
}

function parsePkg(text: string): ParsedPkg | null {
  try {
    const j = JSON.parse(text) as {
      name?: string; description?: string; main?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      raw: text,
      name: j.name,
      description: j.description,
      scripts: j.scripts ?? {},
      deps: j.dependencies ?? {},
      devDeps: j.devDependencies ?? {},
      main: j.main,
    };
  } catch {
    return null;
  }
}

/** Native-ish deps WebContainers cannot always install. */
const NATIVE_DEPS = [
  "sharp", "bcrypt", "canvas", "sqlite3", "better-sqlite3", "node-gyp",
  "grpc", "@grpc/grpc-js", "node-sass", "puppeteer", "playwright", "electron",
  "argon2", "musl", "tedious", "oracle", "ibm_db",
];

const scriptPreference = ["dev", "start", "serve", "preview", "watch", "develop"];

function pickScript(scripts: Record<string, string>, readmeSuggestion: string | null): string | null {
  if (readmeSuggestion && scripts[readmeSuggestion]) return readmeSuggestion;
  for (const name of scriptPreference) {
    if (scripts[name]) return name;
  }
  return null;
}

// ── The analyzer ─────────────────────────────────────────────

/**
 * Analyze the workspace and produce a ready-to-embed StackBlitz
 * project (mode "stackblitz"), a run-locally recipe (mode "local"
 * — Python etc.), or nothing (mode "none").
 */
export async function analyzeStackBlitzProject(
  nodes: LiteNode[],
  read: ProjectFileReader,
  opts?: { root?: string }
): Promise<SBAnalysis> {
  const all = flatten(nodes);
  if (all.length === 0) return { mode: "none", project: null, meta: null };

  const candidates = collectRoots(all);
  const rootOverride = opts?.root?.trim() || null;

  let chosen: RootCandidate | null = null;
  if (rootOverride) {
    const kind = candidates.find((c) => c.root === rootOverride);
    if (kind) chosen = kind;
  } else {
    chosen = candidates[0] ?? null;
    // v4.9 — FRESHEST-WORK-WINS: the agent's CURRENT project is what the
    // live preview should run. Root kinds carry different score baselines
    // (a node root always outscores a static one), so a brand-new static
    // site could lose to a stale Express demo sitting in the workspace.
    // If another candidate's newest file is meaningfully fresher (≥ 60 s)
    // than the top-scored root's newest, the fresher one steals the embed:
    // delete the old app, generate a new site → the NEW site becomes the
    // StackBlitz preview automatically.
    if (chosen) {
      const newestOf = (c: RootCandidate) => c.files.reduce((a, b) => Math.max(a, b.mtime), 0);
      let freshest = chosen;
      let freshestT = newestOf(chosen);
      for (const c of candidates) {
        const t = newestOf(c);
        if (t > freshestT) {
          freshestT = t;
          freshest = c;
        }
      }
      if (freshest !== chosen && freshestT > newestOf(chosen) + 60_000) chosen = freshest;
    }
  }
  if (!chosen) return { mode: "none", project: null, meta: null };

  // Mixed stack (FastAPI backend + static frontend — the agent's favourite):
  // a python root alone can't run in StackBlitz, but its FRONTEND can. Route
  // to the html root and attach the backend as a "runs locally" companion.
  if (chosen.kind === "python" && !rootOverride) {
    const htmlCandidate = candidates.find((c) => c.kind === "html");
    if (htmlCandidate) chosen = htmlCandidate;
  }

  const root = chosen.root;
  const relOf = (p: string) => (root === "" ? p : p.startsWith(root + "/") ? p.slice(root.length + 1) : null);
  const inRoot = all.filter((f) => relOf(f.path) !== null);

  // best static page workspace-wide (fallback / companion links)
  const htmlPages = all
    .filter((f) => /\.html?$/i.test(f.path))
    .sort((a, b) => {
      const ia = /^index\.html?$/i.test(a.path.slice(a.path.lastIndexOf("/") + 1)) ? 0 : 1;
      const ib = /^index\.html?$/i.test(b.path.slice(b.path.lastIndexOf("/") + 1)) ? 0 : 1;
      if (ia !== ib) return ia - ib;
      return b.mtime - a.mtime;
    });
  const fallbackHtmlEntry = htmlPages[0]?.path ?? null;

  // README + AGENT.md — the PROJECT's README first (it describes this app),
  // the workspace root README as fallback; AGENT.md is always workspace memory.
  const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const readmeRel =
    all.find((f) => /^README\.md$/i.test(baseOf(f.path)) && dirOf(f.path) === root)?.path ??
    all.find((f) => /^README\.md$/i.test(baseOf(f.path)) && dirOf(f.path) === "")?.path ??
    all.find((f) => /^readme[\w.-]*\.(md|txt)$/i.test(baseOf(f.path)) && dirOf(f.path) === root)?.path ??
    null;
  const agentMdRel = all.find((f) => /^AGENT\.md$/i.test(baseOf(f.path)) && dirOf(f.path) === "")?.path ?? null;
  let readmeText = "";
  let agentMdText = "";
  if (readmeRel) readmeText = (await read(readmeRel)) ?? "";
  if (agentMdRel) agentMdText = (await read(agentMdRel)) ?? "";
  const docsText = `${readmeText}\n${agentMdText}`;
  const readmeCommands = extractReadmeCommands(docsText);
  const title = readmeTitle(docsText) ?? (root === "" ? "Agent workspace" : root.split("/").pop() ?? "Agent project");
  const description = readmeDescription(readmeText) ?? undefined;

  // ── Python-only stack → run locally (StackBlitz runs the JS ecosystem) ──
  if (chosen.kind === "python") {
    const pyFiles = inRoot.filter((f) => /\.py$/i.test(f.path)).map((f) => f.path);
    const runCommand =
      pythonRunCommand(readmeCommands, pyFiles) ??
      "pip install -r requirements.txt  # then start the app (see README)";
    return {
      mode: "local",
      project: null,
      meta: {
        root,
        title,
        template: null,
        engine: null,
        startScript: null,
        startCommand: runCommand,
        openFile: null,
        fileCount: pyFiles.length,
        totalBytes: 0,
        skipped: [],
        warnings: [
          "StackBlitz runs the JavaScript ecosystem in the browser (WebContainers) — Python backends run on your machine.",
          fallbackHtmlEntry
            ? "The static frontend pages can still be previewed live below."
            : "No HTML pages found to preview.",
        ],
        readmeCommands,
        detectedFrom: "python",
        stackSummary: ["python", "pip"],
        companionBackend: null,
        fallbackHtmlEntry,
        signature: computeSignature(inRoot),
        analyzedAt: Date.now(),
      },
    };
  }

  // ── Read the shippable file set (bounded) ──
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let total = 0;
  let count = 0;
  const shipSorted = [...chosen.files].sort((a, b) => b.mtime - a.mtime); // freshest first
  const pkgFile = shipSorted.find((f) => /^package\.json$/i.test(f.path.slice(f.path.lastIndexOf("/") + 1)));
  const readmeInRoot = shipSorted.find((f) => /^readme[\w.-]*\.(md|txt)$/i.test(f.path.slice(f.path.lastIndexOf("/") + 1)));

  // always try to keep package.json + README even past caps
  const priority = [pkgFile, readmeInRoot].filter(Boolean) as FlatFile[];
  for (const f of [...priority, ...shipSorted]) {
    const rel = relOf(f.path);
    if (rel === null || files[rel] !== undefined) continue;
    if (count >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
      if (skipped.length < MAX_SKIPPED_LISTED) skipped.push(rel);
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      if (f !== pkgFile && f !== readmeInRoot) {
        if (skipped.length < MAX_SKIPPED_LISTED) skipped.push(`${rel} (${(f.size / 1024).toFixed(0)} KB)`);
        continue;
      }
    }
    const text = await read(f.path);
    if (text === null) {
      if (skipped.length < MAX_SKIPPED_LISTED) skipped.push(rel);
      continue;
    }
    files[rel] = text;
    total += text.length;
    count++;
  }
  if (count === 0) return { mode: "none", project: null, meta: null };

  // ── Node / WebContainers project ──
  if (chosen.kind === "node" && pkgFile) {
    const pkgText = await read(pkgFile.path);
    const pkg = pkgText ? parsePkg(pkgText) : null;
    if (!pkg) {
      // corrupt package.json → treat as static
    } else {
      const scripts = { ...pkg.scripts };
      const depNames = Object.keys(pkg.deps);
      const allDepNames = [...depNames, ...Object.keys(pkg.devDeps)];
      const hasCRA = depNames.includes("react-scripts");
      const hasAngular = depNames.includes("@angular/core");
      const hasVite = allDepNames.includes("vite");
      const hasNext = depNames.includes("next");
      const template: SBTemplate = hasCRA ? "create-react-app" : hasAngular && !hasVite ? "angular-cli" : "node";
      const engine: SBEngine = template === "node" ? "webcontainers" : "engineblock";

      // start script: README's word > scripts preference > synthesized
      let script = pickScript(scripts, readmeScript(readmeCommands));
      let startScriptName: string | null = script;
      if (!script) {
        const main =
          pkg.main ??
          readmeNodeEntry(readmeCommands) ??
          ["index.js", "server.js", "app.js", "main.js", "src/index.js", "src/index.ts", "src/main.ts"].find((c) =>
            files[c] !== undefined
          );
        if (main) {
          scripts.start = `node ${main}`;
          script = "start";
          startScriptName = "start";
        } else {
          startScriptName = null;
        }
      }

      // inject the auto-run key (docs pattern: stackblitz.startCommand)
      const sbPkg: Record<string, unknown> = {
        ...JSON.parse(pkg.raw ?? "{}"),
        scripts,
        stackblitz: {
          installDependencies: true,
          ...(script ? { startCommand: `npm run ${script}` } : {}),
        },
      };
      const rootRel = relOf(pkgFile.path) ?? "package.json";
      files[rootRel] = `${JSON.stringify(sbPkg, null, 2)}\n`;

      const warnings: string[] = [];
      const natives = allDepNames.filter((d) => NATIVE_DEPS.includes(d));
      if (natives.length > 0) warnings.push(`Native deps (${natives.join(", ")}) may not install in WebContainers.`);
      if (hasNext) warnings.push("Next.js boots in WebContainers but the first compile takes a while.");
      if (!script) warnings.push("No start script found — the terminal is interactive; type the run command there.");
      if (skipped.length > 0) warnings.push(`${skipped.length}+ file(s) skipped (binary/oversized).`);
      // port hint only from JS run commands (READMEs of mixed projects also
      // mention uvicorn/flask ports that don't belong to this JS app)
      const port = detectPort(readmeCommands.filter((c) => /^(?:npm|npx|node|bun|yarn|pnpm)\b/.test(c)));
      if (port) warnings.push(`README says the app listens on :${port} — the embed opens it automatically.`);

      const openFile =
        files["README.md"] !== undefined ? "README.md"
        : files["index.html"] !== undefined ? "index.html"
        : files["src/index.js"] !== undefined ? "src/index.js"
        : files["src/App.tsx"] !== undefined ? "src/App.tsx"
        : Object.keys(files).find((k) => /\.(js|ts|tsx|jsx)$/i.test(k)) ?? rootRel;

      const stackSummary = [...depNames, ...Object.keys(pkg.devDeps)]
        .filter((d) => !d.startsWith("@types/") && !d.startsWith("@babel/"))
        .slice(0, 8);

      const payload: SBProjectPayload = {
        title: pkg.name?.replace(/^[-_]+|[-_]+$/g, "") || title,
        description: pkg.description || description,
        template,
        files,
        settings: { compile: { trigger: "auto", clearConsole: false } },
      };

      return {
        mode: "stackblitz",
        project: payload,
        meta: {
          root,
          title: payload.title,
          template,
          engine,
          startScript: startScriptName,
          startCommand: script ? `npm run ${script}` : null,
          openFile,
          fileCount: count,
          totalBytes: total,
          skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
          warnings,
          readmeCommands,
          detectedFrom: readmeScript(readmeCommands) ? "readme" : "package.json",
          stackSummary,
          companionBackend: null,
          fallbackHtmlEntry,
          signature: computeSignature(inRoot),
          analyzedAt: Date.now(),
        },
      };
    }
  }

  // ── Static HTML/JS project → WebContainers with a generated server ──
  // Legacy EngineBlock embeds are deprecated; instead the static app ships
  // with a tiny zero-dependency node server (.stackblitz-serve.js) so it
  // boots in WebContainers like any other app — deps "install" instantly,
  // `npm start` auto-runs, and the live terminal shows request logs.
  const hasTs = Object.keys(files).some((k) => /\.(ts|tsx)$/i.test(k) && !/\.d\.ts$/i.test(k));
  const slug =
    title
      .toLowerCase()
      .replace(/[^\w\u00c0-\uffff]+/g, "-")
      .replace(/^[-]+|[-]+$/g, "")
      .slice(0, 48) || "agent-app";
  if (files["package.json"] === undefined) {
    files["package.json"] =
      `${JSON.stringify(
        {
          name: slug,
          private: true,
          scripts: { start: "node .stackblitz-serve.js" },
          stackblitz: { installDependencies: true, startCommand: "npm start" },
        },
        null,
        2
      )}\n`;
    files[".stackblitz-serve.js"] = STATIC_SERVER_JS;
  }
  const payload: SBProjectPayload = {
    title,
    description,
    template: "node",
    files,
    settings: { compile: { trigger: "auto", clearConsole: false } },
  };

  // companion python backend? (static frontend + python backend in the same workspace)
  const pyAnywhere = all.some((f) => /\.py$/i.test(f.path));
  const pyRootMarker = all.some((f) =>
    /^(requirements[\w.-]*\.txt|pyproject\.toml)$/i.test(f.path.slice(f.path.lastIndexOf("/") + 1))
  );
  let companion: { kind: string; runCommand: string } | null = null;
  if (pyAnywhere && pyRootMarker) {
    const pyFiles = all.filter((f) => /\.py$/i.test(f.path)).map((f) => f.path);
    companion = {
      kind: "python",
      runCommand:
        pythonRunCommand(readmeCommands, pyFiles) ??
        "pip install -r requirements.txt  # then start the backend (see README)",
    };
  }

  const warnings: string[] = [];
  if (skipped.length > 0) warnings.push(`${skipped.length}+ file(s) skipped (binary/oversized).`);
  if (companion) {
    warnings.push(
      `This is the static frontend — the ${companion.kind} backend runs locally: ${companion.runCommand}`
    );
  }

  const openFile =
    files["index.html"] !== undefined ? "index.html"
    : files["README.md"] !== undefined ? "README.md"
    : Object.keys(files)[0];

  return {
    mode: "stackblitz",
    project: payload,
    meta: {
      root,
      title,
      template: "node",
      engine: "webcontainers",
      startScript: "start",
      startCommand: "npm start",
      openFile,
      fileCount: count,
      totalBytes: total,
      skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
      warnings,
      readmeCommands,
      detectedFrom: "html",
      stackSummary: hasTs ? ["typescript", "static"] : ["html", "javascript", "static"],
      companionBackend: companion,
      fallbackHtmlEntry,
      signature: computeSignature(inRoot),
      analyzedAt: Date.now(),
    },
  };
}

// ── The generated static server (runs in WebContainers, zero deps) ──

const STATIC_SERVER_JS = `// Generated by the Job Command Center v4.8 — serves this static app
// inside StackBlitz WebContainers. Requests log to the live terminal.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".csv": "text/csv", ".xml": "application/xml", ".pdf": "application/pdf",
};

http.createServer(function (req, res) {
  try {
    var urlPath = decodeURIComponent(String(req.url || "/").split("?")[0]);
    if (urlPath.charAt(urlPath.length - 1) === "/") urlPath += "index.html";
    var file = path.normalize(path.join(ROOT, urlPath));
    if (file.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end("403"); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      var fallback = path.join(ROOT, "index.html");
      if (fs.existsSync(fallback)) file = fallback; // SPA-style fallback
      else { res.writeHead(404, { "content-type": "text/plain" }); return res.end("404 - " + urlPath); }
    }
    var ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
    console.log(req.method + " " + urlPath + " -> 200");
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("500 - " + err);
  }
}).listen(PORT, function () {
  console.log("static app running on :" + PORT);
});
`;

// Re-export for the API route's tree type bridging.
export type { LiteNode as SBTreeNode };
// v4.8.2
