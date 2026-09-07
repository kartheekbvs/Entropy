// ─────────────────────────────────────────────────────────────
// v4.7 END-TO-END AGENT-WRITE PROOF
//
// Starts a REAL coding-agent run with a trivial goal, watches the
// preview SSE stream, and asserts the agent's fs_write fires the
// bus `write` event (layer 1: ~0 ms latency, vs the 1.5 s poll of
// layer 2) — the exact path that live-reloads the webview while
// the agent works.
//
// Run: bun scripts/test-v47-e2e.ts
// ─────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const TARGET = "e2e-preview-demo/hello.html";
const wsRoot = process.env.AGENT_WORKSPACE?.trim() || `${process.cwd()}/workspace`;

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

async function main() {
  console.log("v4.7 E2E — real agent write → SSE write event → previewable page");
  await fs.rm(`${wsRoot}/${TARGET}`, { force: true }).catch(() => undefined);

  // 1. subscribe FIRST so we don't miss the event
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/preview/events`, { signal: ctrl.signal });
  const reader = sse.body?.getReader();
  const dec = new TextDecoder();
  const events: Array<{ event: string; data: string }> = [];
  const pump = (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = (await reader?.read()) ?? { value: undefined, done: true };
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = chunk.split("\n");
          if (lines.length >= 2 && lines[0].startsWith("event: ") && lines[1].startsWith("data: ")) {
            events.push({ event: lines[0].slice(7), data: lines.slice(1).join("\n").slice(6) });
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  // 2. start the real run (or adopt the busy one)
  const start = await fetch(`${BASE}/api/agent/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: `Use fs_write to create the file ${TARGET} with exactly this content: <!DOCTYPE html><html><head><title>E2E</title></head><body><h1>E2E preview works</h1></body></html> — then reply done. No other files needed.`,
      kind: "coding",
      mode: "manual",
    }),
  });
  const startBody = (await start.json()) as {
    run?: { id?: string };
    activeRunId?: string;
    error?: string;
  };
  let runId = startBody.run?.id ?? null;
  if (!runId && startBody.activeRunId) {
    console.log(`  ⏳ another run is active (${startBody.activeRunId}) — adopting it and waiting…`);
    runId = startBody.activeRunId;
  }
  check("run: coding agent started", Boolean(runId), startBody.error ?? runId ?? "");
  if (!runId) {
    ctrl.abort();
    process.exit(1);
  }
  console.log(`  ⏱ agent run ${runId} — waiting for the write event (≤180s)…`);

  // 3. wait for the write event for our target file
  const deadline = Date.now() + 180_000;
  let writeEvent: { event: string; data: string } | null = null;
  let lastStatus = "";
  while (Date.now() < deadline) {
    writeEvent = events.find((e) => e.event === "write" && e.data.includes(TARGET)) ?? null;
    if (writeEvent) break;
    // progress heartbeat: poll run status every 10s
    if (Math.floor(Date.now() / 250) % 40 === 0) {
      const run = await fetch(`${BASE}/api/agent/run?id=${runId}`).catch(() => null);
      if (run?.ok) {
        const rj = (await run.json()) as { run?: { status?: string } };
        const s = rj.run?.status ?? "?";
        if (s !== lastStatus) {
          lastStatus = s;
          console.log(`     · run status: ${s}`);
        }
        if (s === "completed" || s === "failed" || s === "interrupted") {
          // give the stream a moment, then stop waiting
          await new Promise((r2) => setTimeout(r2, 2000));
          break;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  check("e2e: agent fs_write fired the SSE write event", Boolean(writeEvent),
    writeEvent ? writeEvent.data.slice(0, 80) : `${events.length} events seen, last status ${lastStatus}`);
  if (writeEvent) {
    const latency = Number(/"ts":(\d+)/.exec(writeEvent.data)?.[1] ?? 0);
    console.log(`     · write event payload: ${writeEvent.data}`);
  }

  // 4. the page must now serve through the webview route
  await new Promise((r) => setTimeout(r, 500));
  const page = await fetch(`${BASE}/api/preview/${TARGET}`, { redirect: "manual" });
  check("e2e: written page serves on /api/preview", page.status === 200, `status ${page.status}`);
  if (page.status === 200) {
    const html = await page.text();
    check("e2e: page content intact", html.includes("E2E preview works"));
    check("e2e: page carries the injected runtime", html.includes("__JCC_PREVIEW_RUNTIME__"));
  }

  ctrl.abort();
  await pump.catch(() => undefined);

  // cleanup (keep the demo file? remove — the workspace is the user's)
  await fs.rm(`${wsRoot}/${TARGET}`, { force: true }).catch(() => undefined);

  console.log("");
  if (failures.length === 0) console.log("✅ E2E PROOF COMPLETE — agent writes live-reload the webview");
  else {
    console.log(`❌ ${failures.length} FAILURE(S)`);
    for (const f of failures) console.log(`   – ${f}`);
    process.exit(1);
  }
}

void main();
