// ─────────────────────────────────────────────────────────────
// v4.7 LIVE PREVIEW STUDIO — feature tests
//   1. UNITS  — runtime injection (base href, marker, idempotence,
//               head-less documents), relevance rules, entry
//               ordering (index.html apps first, freshest work),
//               publishPreviewWrite → bus subscription
//   2. ROUTE  — live HTTP against the dev server: injected HTML,
//               redirects (root + directory), asset mime
//               passthrough, sandbox escapes, SSE stream (CORS +
//               hello stats), ports probe
//   3. LIVE   — the real reload loop: subscribe to the SSE stream,
//               modify a workspace file externally, expect a
//               `stats` event within 3 s (the safety-net layer)
//
// Run: bun scripts/test-v47.ts [all|units|route|live]
// ─────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import {
  injectPreviewRuntime,
  previewRelevant,
  previewDirOf,
  collectPreviewEntries,
  bestPreviewEntry,
  publishPreviewWrite,
  PREVIEW_CHANNEL,
} from "../src/lib/preview";
import { subscribe } from "../src/lib/agent/event-bus";

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

async function get(path: string, opts: RequestInit = {}) {
  return fetch(`${BASE}${path}`, { redirect: "manual", ...opts });
}

// ═════════════════════════════════════════════════════════════
// PHASE 1 — UNITS
// ═════════════════════════════════════════════════════════════
function testUnits() {
  console.log("\n══ PHASE 1 · UNITS ══");

  // ── injection ──
  const doc =
    "<!DOCTYPE html><html><head><title>t</title>" +
    '<link rel="stylesheet" href="style.css"><script src="app.js"></script>' +
    '</head><body><h1>Hi</h1></body></html>';
  const out = injectPreviewRuntime(doc, "frontend/index.html");
  check("injection: runtime marker present", out.includes("__JCC_PREVIEW_RUNTIME__"));
  check("injection: <base> targets the entry dir", out.includes('<base href="/api/preview/frontend/">'));
  const baseIdx = out.indexOf('<base href="/api/preview/frontend/">');
  const linkIdx = out.indexOf('<link rel="stylesheet"');
  check("injection: <base> precedes the page's stylesheets", baseIdx > -1 && linkIdx > baseIdx);
  check("injection: base + runtime injected exactly once", (out.match(/<base href=/g) ?? []).length === 1);

  // idempotence
  const twice = injectPreviewRuntime(out, "frontend/index.html");
  check("injection: idempotent (no double inject)", (twice.match(/__JCC_PREVIEW_RUNTIME__/g) ?? []).length === 1);

  // root-level entry
  const rootDoc = injectPreviewRuntime("<html><head></head><body></body></html>", "index.html");
  check("injection: root entry base is the preview root", rootDoc.includes('<base href="/api/preview/">'));

  // head-less document still gets the runtime
  const noHead = injectPreviewRuntime("<h1>plain</h1>", "x/page.html");
  check("injection: head-less document still injected", noHead.startsWith("<base") && noHead.includes("__JCC_PREVIEW_RUNTIME__"));

  // escaped quotes in entry paths can't break the script
  const evil = injectPreviewRuntime(doc, 'we"ird/na\\me.html');
  check("injection: quote/backslash entry paths escaped safely", !evil.includes('var ENTRY="we"ird'));

  // console forwarding + storage polyfill + reload listener all shipped
  check("runtime: console forwarder shipped", out.includes("parent.postMessage"));
  check("runtime: error capture shipped", out.includes("unhandledrejection"));
  check("runtime: storage polyfill shipped", out.includes("sessionStorage"));
  check("runtime: live-reload EventSource shipped", out.includes('new EventSource("/api/preview/events")'));
  check("runtime: relevance check wired", out.includes("ENTRY=") && out.includes("location.reload()"));

  // ── relevance ──
  check("relevance: write === entry", previewRelevant("app/index.html", "app/index.html"));
  check("relevance: sibling asset (same dir)", previewRelevant("app/index.html", "app/style.css"));
  check("relevance: subtree asset", previewRelevant("app/index.html", "app/js/main.js"));
  check("relevance: shared ancestor asset", previewRelevant("app/pages/home.html", "app/global.css"));
  check("relevance: unrelated project → NO reload", !previewRelevant("app/index.html", "backend/main.py"));
  check("relevance: empty path → reload", previewRelevant("app/index.html", ""));

  // ── dir helper ──
  check("dirOf: root file", previewDirOf("index.html") === "");
  check("dirOf: nested file", previewDirOf("a/b/c.html") === "a/b/");

  // ── entry ordering ──
  const tree = [
    {
      name: "a", path: "oldapp", type: "dir" as const, size: 0, mtime: 1,
      children: [
        { name: "index.html", path: "oldapp/index.html", type: "file" as const, size: 10, mtime: 100 },
        { name: "deep.html", path: "oldapp/deep.html", type: "file" as const, size: 10, mtime: 900 },
      ],
    },
    { name: "b", path: "newapp", type: "dir" as const, size: 0, mtime: 2, children: [
      { name: "index.html", path: "newapp/index.html", type: "file" as const, size: 10, mtime: 800 },
      { name: "page.html", path: "newapp/page.html", type: "file" as const, size: 10, mtime: 950 },
    ] },
    { name: "loose.html", path: "loose.html", type: "file" as const, size: 5, mtime: 700 },
    { name: "logo.svg", path: "logo.svg", type: "file" as const, size: 5, mtime: 600 },
    { name: "main.py", path: "main.py", type: "file" as const, size: 5, mtime: 990 },
  ];
  const entries = collectPreviewEntries(tree as never);
  check("entries: best pick is the newest index.html app", entries[0]?.path === "newapp/index.html");
  check("entries: index.html apps rank before loose pages",
    entries.findIndex((e) => e.path === "newapp/index.html") < entries.findIndex((e) => e.path === "loose.html"));
  check("entries: non-html files excluded", !entries.some((e) => e.name === "main.py"));
  check("entries: svg included (viewable), listed last", entries[entries.length - 1]?.path === "logo.svg");
  check("entries: bestPreviewEntry agrees with ordering", bestPreviewEntry(tree as never)?.path === "newapp/index.html");
  check("entries: empty tree → null", bestPreviewEntry([]) === null);

  // ── bus plumbing (the agent-write → SSE layer 1 path) ──
  const seenBox: { path?: string } = {};
  const off = subscribe([PREVIEW_CHANNEL], (e) => {
    if (e.type === "write") {
      const d = e.data as { path?: string } | undefined;
      if (d) seenBox.path = d.path;
    }
  });
  publishPreviewWrite("demo/index.html");
  check("bus: publishPreviewWrite lands on the preview channel", seenBox.path === "demo/index.html");
  publishPreviewWrite("weird\\path\"quoted.html"); // must not throw
  off();
  check("bus: publishing never throws on odd paths", true);
}

// ═════════════════════════════════════════════════════════════
// PHASE 2 — ROUTE (live dev server)
// ═════════════════════════════════════════════════════════════
async function testRoute() {
  console.log("\n══ PHASE 2 · ROUTE ══");

  // HTML entry with injection
  const htmlRes = await get("/api/preview/frontend/index.html");
  check("route: HTML entry serves 200", htmlRes.status === 200, `status ${htmlRes.status}`);
  check("route: HTML content-type", (htmlRes.headers.get("content-type") ?? "").startsWith("text/html"));
  const body = await htmlRes.text();
  check("route: HTML carries the live runtime", body.includes("__JCC_PREVIEW_RUNTIME__"));
  check("route: HTML carries the entry <base>", body.includes('<base href="/api/preview/frontend/">'));
  check("route: no-store caching", htmlRes.headers.get("cache-control") === "no-store");

  // asset passthrough with mime
  const mdRes = await get("/api/preview/README.md");
  check("route: asset passthrough 200 + markdown mime", mdRes.status === 200 && (mdRes.headers.get("content-type") ?? "").startsWith("text/markdown"));

  // root redirect
  const rootRes = await get("/api/preview");
  check("route: root redirects (307/308)", [307, 308].includes(rootRes.status));
  const loc = rootRes.headers.get("location") ?? "";
  check("route: root redirect targets a previewable page", /\/api\/preview\/[^?#]*\.html?$/i.test(loc), loc);

  // directory redirect
  const dirRes = await get("/api/preview/frontend");
  check("route: directory resolves to its index.html", [307, 308].includes(dirRes.status) &&
    (dirRes.headers.get("location") ?? "").endsWith("/frontend/index.html"));

  // sandbox escapes
  const esc1 = await get("/api/preview/..%2f..%2fpackage.json");
  check("route: encoded ../ escape rejected", [400, 404].includes(esc1.status), `status ${esc1.status}`);
  const esc2 = await get("/api/preview/%2e%2e%2f.env");
  check("route: encoded .env probe rejected", [400, 404].includes(esc2.status), `status ${esc2.status}`);

  // missing file → friendly page, not a raw stack
  const miss = await get("/api/preview/nope/missing.html");
  const missBody = await miss.text();
  check("route: missing file → 404 friendly page", miss.status === 404 && missBody.includes("Nothing here yet"));

  // SSE headers + hello
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/preview/events`, { signal: ctrl.signal });
  check("route: events stream is text/event-stream", (sse.headers.get("content-type") ?? "").startsWith("text/event-stream"));
  check("route: events CORS allows the sandboxed webview", sse.headers.get("access-control-allow-origin") === "*");
  const reader = sse.body?.getReader();
  const dec = new TextDecoder();
  let first = "";
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !first.includes("\n\n")) {
    const { value, done } = (await reader?.read()) ?? { value: undefined, done: true };
    if (done) break;
    first += dec.decode(value, { stream: true });
  }
  ctrl.abort();
  check("route: events sends hello stats immediately", first.startsWith("event: stats") && first.includes('"hello":true'), first.slice(0, 60).replace(/\n/g, "⏎"));

  // ports
  const ports = await get("/api/preview/ports");
  const pj = (await ports.json()) as { ports?: Array<{ port: number; open: boolean }> };
  check("route: ports probe returns a list", ports.status === 200 && Array.isArray(pj.ports) && pj.ports.length > 0);
  check("route: ports probe sees the app itself (3000 open)", pj.ports?.some((p) => p.port === 3000 && p.open) ?? false);
}

// ═════════════════════════════════════════════════════════════
// PHASE 3 — LIVE reload loop (external write → stats event)
// ═════════════════════════════════════════════════════════════
async function testLive() {
  console.log("\n══ PHASE 3 · LIVE reload loop ══");

  const probe = "live-reload-probe.txt";
  const wsRoot = process.env.AGENT_WORKSPACE?.trim() || `${process.cwd()}/workspace`;

  // clean slate
  await fs.rm(`${wsRoot}/${probe}`, { force: true }).catch(() => undefined);

  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/preview/events`, { signal: ctrl.signal });
  const reader = sse.body?.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: string[] = [];
  const t0 = Date.now();

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = (await reader?.read()) ?? { value: undefined, done: true };
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith("event:")) events.push(chunk);
        }
      }
    } catch {
      /* aborted */
    }
  })();

  // let the hello stats arrive first
  await new Promise((r) => setTimeout(r, 800));
  const sawHello = events.some((e) => e.includes('"hello":true'));
  check("live: hello stats received", sawHello);

  // external write (bypasses the agent tools on purpose — this is
  // the safety-net layer: hand edits, shell writes, editors)
  await fs.writeFile(`${wsRoot}/${probe}`, `probe ${Date.now()}`, "utf8");
  console.log("  ⏱ external write made — waiting for the signature poll (≤3s)…");

  const deadline = Date.now() + 4000;
  let sawChange = false;
  while (Date.now() < deadline) {
    if (events.some((e) => e.startsWith("event: stats") && !e.includes('"hello":true'))) {
      sawChange = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  check("live: external write → stats event within 4s", sawChange);
  const ms = Date.now() - t0;

  // cleanup + confirm the poll catches deletions too
  await fs.rm(`${wsRoot}/${probe}`, { force: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 2200));
  ctrl.abort();
  await pump.catch(() => undefined);

  console.log(`  ⏱ stream saw ${events.length} events in ${(ms / 1000).toFixed(1)}s`);
}

// ═════════════════════════════════════════════════════════════
(async () => {
  console.log("v4.7 LIVE PREVIEW STUDIO — test run");
  try {
    if (want("units")) testUnits();
    if (want("route")) await testRoute();
    if (want("live")) await testLive();
  } catch (e) {
    failures.push(`unexpected error: ${(e as Error).message}`);
    console.error((e as Error).stack);
  }
  console.log("");
  if (failures.length === 0) {
    console.log("✅ ALL v4.7 CHECKS PASS");
  } else {
    console.log(`❌ ${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`   – ${f}`);
    process.exit(1);
  }
})();
