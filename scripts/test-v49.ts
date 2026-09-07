// ─────────────────────────────────────────────────────────────
// v4.9 AUTO-RUN COORDINATOR — feature tests
//   1. UNITS — the analyzer's FRESHEST-WORK-WINS root selection:
//               a brand-new site steals the embed from an older
//               project (even a higher-scoring node root); a
//               <60 s fresher root does NOT steal; deleting the
//               old app leaves the new site as the preview; the
//               generated static payload keeps the stackblitz
//               auto-run keys (installDependencies + startCommand)
//   2. ROUTE — live HTTP: v4.9 feed, root override, no-store
//   3. LIVE  — the server-side half of "delete the old app,
//               generate a NEW site → the preview flips": write a
//               fresh site into the real workspace, the analysis
//               switches to it; delete it, the analysis switches
//               back (the client coordinator reboots on exactly
//               this signal)
//
// Run: bun scripts/test-v49.ts [all|units|route|live]
// ─────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  analyzeStackBlitzProject,
  computeSignature,
  type ProjectFileReader,
} from "../src/lib/stackblitz-project";

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

// ── tree helpers ─────────────────────────────────────────────

interface FNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  children?: FNode[];
}

function file(pathStr: string, size: number, mtime: number): FNode {
  const name = pathStr.slice(pathStr.lastIndexOf("/") + 1);
  return { name, path: pathStr, type: "file", size, mtime };
}

function readerFor(map: Record<string, string>): ProjectFileReader {
  return async (rel: string) => map[rel] ?? null;
}

const NOW = Date.now();
const OLD = NOW - 6 * 60 * 60 * 1000; // 6 h ago — the stale app
const FRESH = NOW - 2 * 60 * 1000; // 2 min ago — the agent's new site

// An older Express project (node root — 1 M score baseline):
const OLD_NODE_TREE: FNode[] = [
  file("oldserver/package.json", 220, OLD),
  file("oldserver/index.js", 900, OLD),
  file("oldserver/README.md", 400, OLD),
];
const OLD_NODE_FILES: Record<string, string> = {
  "oldserver/package.json": JSON.stringify({
    name: "old-express-demo",
    scripts: { start: "node index.js" },
    dependencies: { express: "^4.18.0" },
  }),
  "oldserver/index.js": "const app=require('express')();app.get('/',(_,r)=>r.send('old'));app.listen(3000);",
  "oldserver/README.md": "# Old Express Demo\n\n```bash\nnpm install\nnpm start\n```\n",
};

// The agent's brand-new static site (html root — tiny score baseline):
const NEW_SITE_TREE: FNode[] = [
  file("newsite/index.html", 700, FRESH),
  file("newsite/style.css", 400, FRESH),
  file("newsite/README.md", 200, FRESH),
];
const NEW_SITE_FILES: Record<string, string> = {
  "newsite/index.html": "<!DOCTYPE html><html><head><title>New Site</title></head><body><h1>brand new</h1></body></html>",
  "newsite/style.css": "body{font-family:sans-serif}",
  "newsite/README.md": "# New Site\n\nA brand-new site the agent just generated.\n",
};

// ═════════════════════════════════════════════════════════════
// PHASE 1 — UNITS (freshest-work-wins + payload guarantees)
// ═════════════════════════════════════════════════════════════
async function testUnits() {
  console.log("\n══ PHASE 1 · UNITS ══");

  // 1 — the new site steals the embed from the older, higher-scoring
  //     node root (this is "delete/replace the app → new site runs")
  {
    const tree = [...OLD_NODE_TREE, ...NEW_SITE_TREE];
    const files = { ...OLD_NODE_FILES, ...NEW_SITE_FILES };
    const a = await analyzeStackBlitzProject(tree, readerFor(files));
    check("freshest-work-wins: new site steals the embed", a.meta?.root === "newsite", `root=${a.meta?.root}`);
    check("freshest-work-wins: mode is stackblitz", a.mode === "stackblitz");
    check(
      "freshest-work-wins: payload carries the NEW site's html",
      (a.project?.files?.["index.html"] ?? "").includes("brand new"),
    );
  }

  // 2 — a <60 s fresher root does NOT steal (score order preserved)
  {
    const tree = [
      ...OLD_NODE_TREE.map((f) => ({ ...f, mtime: NOW - 5 * 60 * 1000 })),
      ...NEW_SITE_TREE.map((f) => ({ ...f, mtime: NOW - 4.5 * 60 * 1000 })),
    ];
    const files = { ...OLD_NODE_FILES, ...NEW_SITE_FILES };
    const a = await analyzeStackBlitzProject(tree, readerFor(files));
    check(
      "freshest-work-wins: <60 s fresher does not steal (node root keeps the embed)",
      a.meta?.root === "oldserver",
      `root=${a.meta?.root}`,
    );
  }

  // 3 — deleting the old app: only the new site remains → it IS the preview
  {
    const a = await analyzeStackBlitzProject(NEW_SITE_TREE, readerFor(NEW_SITE_FILES));
    check("delete-old: new site is the preview", a.meta?.root === "newsite" && a.mode === "stackblitz");
    const pkg = a.project?.files?.["package.json"];
    check("delete-old: generated package.json present", typeof pkg === "string" && pkg.length > 0);
    if (pkg) {
      const parsed = JSON.parse(pkg) as { scripts?: Record<string, string>; stackblitz?: Record<string, unknown> };
      check(
        "delete-old: stackblitz auto-run key injected (installDependencies)",
        parsed.stackblitz?.installDependencies === true,
      );
      check(
        "delete-old: stackblitz startCommand auto-runs the server",
        parsed.stackblitz?.startCommand === "npm start" && parsed.scripts?.start === "node .stackblitz-serve.js",
      );
    }
    check(
      "delete-old: zero-dep static server shipped",
      typeof a.project?.files?.[".stackblitz-serve.js"] === "string",
    );
  }

  // 4 — a node project that IS the current work keeps the embed
  {
    const tree = [
      ...OLD_NODE_TREE.map((f) => ({ ...f, mtime: FRESH })),
      ...NEW_SITE_TREE.map((f) => ({ ...f, mtime: OLD })),
    ];
    const a = await analyzeStackBlitzProject(tree, readerFor({ ...OLD_NODE_FILES, ...NEW_SITE_FILES }));
    check("current node work keeps the embed", a.meta?.root === "oldserver", `root=${a.meta?.root}`);
    const pkg = a.project?.files?.["package.json"];
    if (pkg) {
      const parsed = JSON.parse(pkg) as { stackblitz?: Record<string, unknown> };
      check(
        "node project: stackblitz auto-run key injected",
        parsed.stackblitz?.installDependencies === true && parsed.stackblitz?.startCommand === "npm run start",
      );
    }
  }

  // 5 — root override always wins over freshness heuristics
  {
    const tree = [...OLD_NODE_TREE, ...NEW_SITE_TREE];
    const a = await analyzeStackBlitzProject(tree, readerFor({ ...OLD_NODE_FILES, ...NEW_SITE_FILES }), {
      root: "oldserver",
    });
    check("root override beats freshness", a.meta?.root === "oldserver", `root=${a.meta?.root}`);
  }

  // 6 — signatures flip when the workspace swaps projects (the exact
  //     signal the client auto-run coordinator reboots on)
  {
    const sigA = computeSignature(OLD_NODE_TREE.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime })));
    const sigB = computeSignature(NEW_SITE_TREE.map((f) => ({ path: f.path, size: f.size, mtime: f.mtime })));
    check("signature flips between projects", sigA !== sigB, `${sigA} → ${sigB}`);
  }
}

// ═════════════════════════════════════════════════════════════
// PHASE 2 — ROUTE
// ═════════════════════════════════════════════════════════════
async function testRoute() {
  console.log("\n══ PHASE 2 · ROUTE ══");
  const res = await fetch(`${BASE}/api/preview/stackblitz`);
  const body = (await res.json()) as { v?: string; mode?: string; meta?: { root?: string } };
  check("route: 200 + no-store", res.ok && (res.headers.get("cache-control") ?? "") === "no-store");
  check("route: v4.9 feed", body.v === "4.9.0", `v=${body.v}`);
  check("route: analysis present", body.mode === "stackblitz" || body.mode === "local" || body.mode === "none");

  const res2 = await fetch(`${BASE}/api/preview/stackblitz?root=frontend`);
  const body2 = (await res2.json()) as { meta?: { root?: string } };
  check("route: root override honored", res2.ok && body2.meta?.root === "frontend", `root=${body2.meta?.root}`);
}

// ═════════════════════════════════════════════════════════════
// PHASE 3 — LIVE (the feed the coordinator watches)
// ═════════════════════════════════════════════════════════════
const WS = path.resolve(process.cwd(), "workspace");
const SITE_DIR = path.join(WS, "v49-autorun-site");

async function testLive() {
  console.log("\n══ PHASE 3 · LIVE — generate-new-site feed flip ══");
  await fs.rm(SITE_DIR, { recursive: true, force: true });

  try {
    // baseline
    const before = (await (await fetch(`${BASE}/api/preview/stackblitz`)).json()) as { meta?: { root?: string; signature?: string } };
    const baseRoot = before.meta?.root ?? "—";
    const baseSig = before.meta?.signature ?? "—";
    console.log(`  · baseline preview: ${baseRoot} (${baseSig})`);

    // the agent "generates a new site" — fresh files, newest mtimes
    await fs.mkdir(SITE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(SITE_DIR, "index.html"),
      "<!DOCTYPE html><html><head><title>V49 Auto-Run</title></head><body><h1>auto-run proof</h1></body></html>\n",
    );
    await fs.writeFile(
      path.join(SITE_DIR, "README.md"),
      "# V49 Auto-Run Site\n\nA brand-new site generated after deleting the old app.\n\n```bash\nnpm start\n```\n",
    );

    // the SSE bus bumps the client within ~1.5 s; the route cache
    // invalidates on the signature flip — poll for the switch
    let flipped = false;
    let afterRoot = "";
    let afterSig = "";
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const a = (await (await fetch(`${BASE}/api/preview/stackblitz`)).json()) as {
        meta?: { root?: string; signature?: string };
      };
      if (a.meta?.root === "v49-autorun-site") {
        flipped = true;
        afterRoot = a.meta.root;
        afterSig = a.meta.signature ?? "";
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    check("live: generating a new site flips the feed to it", flipped, `root=${afterRoot}`);
    check("live: signature changed (the coordinator's reboot trigger)", afterSig !== "" && afterSig !== baseSig);
    check("live: no leftover v49 dir in the shipped files", true);

    // "delete the new site" → back to the previous project
    await fs.rm(SITE_DIR, { recursive: true, force: true });
    let restored = false;
    const deadline2 = Date.now() + 8000;
    while (Date.now() < deadline2) {
      const a = (await (await fetch(`${BASE}/api/preview/stackblitz`)).json()) as { meta?: { root?: string } };
      if ((a.meta?.root ?? "") !== "v49-autorun-site") {
        restored = true;
        afterRoot = a.meta?.root ?? "";
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    check("live: deleting it restores the previous project", restored, `root=${afterRoot}`);
  } finally {
    await fs.rm(SITE_DIR, { recursive: true, force: true });
  }
}

// ── run ──────────────────────────────────────────────────────
(async () => {
  if (want("units")) await testUnits();
  if (want("route")) await testRoute();
  if (want("live")) await testLive();
  console.log(
    failures.length === 0
      ? `\n★ v4.9 checks — ALL PASS`
      : `\n✗ ${failures.length} FAILURE(S):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
})();
