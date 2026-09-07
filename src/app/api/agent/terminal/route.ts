import { NextRequest, NextResponse } from "next/server";
import { subscribe, replay, currentSeq, terminalLine, type AgentBusEvent } from "@/lib/agent/event-bus";
import { executeCodingTool } from "@/lib/agent/coding-tools";
import { getWorkspaceRoot } from "@/lib/workspace";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { VERIFIED_BOARDS, cachedSnapshot } from "@/lib/jobs/remote-python";

const execFile = promisify(execFileCb);

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// ─────────────────────────────────────────────────────────────
// GET /api/agent/terminal?since=<seq> — the v4.0 LIVE TERMINAL.
//
// A real-time SSE feed for the xterm.js console: every agent event
// (rounds, tool calls, results, handoffs, usage, final reports) and
// every command the USER types into the terminal arrives here the
// instant it happens. No page reload, no polling — and a reconnect
// with ?since=<lastSeq> REPLAYS everything it missed from the ring
// buffer, so opening the tab late (or a laptop sleep) loses nothing.
// ─────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0") || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSeq = since;

      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const sendEvent = (e: AgentBusEvent) => {
        if (e.seq <= lastSeq) return;
        lastSeq = e.seq;
        send({ type: e.type, seq: e.seq, ts: e.ts, kind: e.kind, text: e.text, ...(e.data ?? {}) });
      };

      // hello — tells the client the cursor to remember + workspace info
      send({
        type: "hello",
        seq: currentSeq(),
        workspaceRoot: getWorkspaceRoot(),
        replay: Math.max(0, since),
      });

      // replay missed lines (bounded by the ring buffer)
      try {
        for (const e of replay("terminal", since)) sendEvent(e);
      } catch {
        /* ring may be gone after a hot reload — live events resume below */
      }

      const unsubscribe = subscribe(["terminal"], sendEvent);

      // heartbeat keeps proxies from closing the stream
      const ping = setInterval(() => {
        if (closed || req.signal.aborted) {
          cleanup();
          return;
        }
        send({ type: "ping", seq: lastSeq });
      }, 5_000);

      const retire = setTimeout(() => {
        send({ type: "timeout", message: "stream retired after 10 min — reconnecting automatically" });
        cleanup();
      }, 10 * 60 * 1000);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        clearTimeout(retire);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// ─────────────────────────────────────────────────────────────
// BUILT-IN CONSOLE COMMANDS (no shell involved).
//
//   help   — what you can type here
//   status — the ONLINE PREVIEW STACK health check: web app,
//            OpenRelay circular LLM gateway, terminal stream, python
//            runtime, remote-job boards and the workspace — probed
//            live, from inside the console, like a cloud console.
// ─────────────────────────────────────────────────────────────

function helpText(): string {
  return [
    "JCC online console — built-in commands:",
    "  help        this list",
    "  status      live health of the whole online stack (app · relay · stream · python · boards)",
    "",
    "Anything else runs in the workspace sandbox shell (guarded):",
    "  pwd · ls · cat AGENT.md · node -v · python3 -V · bun -v",
    "  python3 scripts/train_demo_model.py · curl http://127.0.0.1:8787/stats",
    "  git status · tsc --version · cat README.md",
    "",
    "Guards: relative paths only · blocklist (sudo, rm -rf /, …) · 60s timeout · output caps.",
  ].join("\n");
}

async function probe(url: string, ms = 2500): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms), cache: "no-store" });
  } catch {
    return null;
  }
}

async function statusText(): Promise<string> {
  const t0 = Date.now();
  const L: string[] = [];

  // 1 — this web app (Next.js dev server) + agent health in one call
  const self = await probe("http://127.0.0.1:3000/api/agent/health");
  let providers = "—";
  let workspace = "—";
  let system = "—";
  if (self?.ok) {
    try {
      const h = (await self.json()) as {
        agent?: { active?: { provider?: string; reason?: string } | string; mode?: string };
        workspace?: { root?: string; files?: number };
        system?: { platform?: string; cpuCores?: number; totalMemoryMB?: number; freeMemoryMB?: number };
      };
      const active =
        typeof h.agent?.active === "string"
          ? { provider: h.agent.active, reason: "" }
          : (h.agent?.active ?? undefined);
      providers = active?.provider ? `${active.provider}${active.reason ? ` — ${active.reason}` : ""}` : "—";
      workspace = `${h.workspace?.files ?? "?"} files @ ${h.workspace?.root ?? "workspace"}`;
      system = `${h.system?.platform ?? ""} · ${h.system?.cpuCores ?? "?"} cpu · ${Math.round(
        ((h.system?.freeMemoryMB ?? 0) / Math.max(1, h.system?.totalMemoryMB ?? 1)) * 100,
      )}% free mem`;
    } catch {
      /* keep placeholders */
    }
  }
  L.push("JCC ONLINE PREVIEW STACK — live status");
  L.push(
    `  ${self?.ok ? "●" : "○"} web app        Next.js (port 3000)          ${self?.ok ? "200 — serving" : "no answer"}`,
  );
  L.push(`    providers       ${providers}`);

  // 2 — OpenRelay circular LLM gateway
  const relay = await probe("http://127.0.0.1:8787/stats");
  let relayLine = "not running (bun --hot server.js in openrelay/)";
  let relayOk = false;
  if (relay?.ok) {
    try {
      const s = (await relay.json()) as {
        usage?: { totals?: { requests?: number; ok?: number; rotations?: number } };
        steps?: Array<{ key?: string }>;
      };
      const chain = (s.steps ?? []).map((x) => x.key?.split("/")[0] ?? "?");
      const uniq = [...new Set(chain)];
      relayOk = true;
      relayLine = `200 — ${uniq.length} providers: ${uniq.join(" → ")} | reqs ${s.usage?.totals?.requests ?? 0} · rotations ${
        s.usage?.totals?.rotations ?? 0
      }`;
    } catch {
      relayLine = "200 (stats unparseable)";
      relayOk = true;
    }
  }
  L.push(`  ${relayOk ? "●" : "○"} openrelay      circular LLM gateway :8787   ${relayLine}`);

  // 3 — terminal stream (this console)
  const seq = currentSeq();
  L.push(`  ● terminal       SSE event stream            live · ${seq} events served`);

  // 4 — python runtime (candidates: the dev server's PATH may miss the venv)
  const PY_CANDIDATES = ["python3", "python", "/home/z/.venv/bin/python3", "/usr/bin/python3", "/usr/local/bin/python3"];
  let pyOk = false;
  let pyDetail = "not found (tried " + PY_CANDIDATES.join(", ") + ")";
  for (const py of PY_CANDIDATES) {
    try {
      const { stdout } = await execFile(py, ["-c", "import fastapi,uvicorn,joblib,sklearn;print('ok')"], {
        timeout: 6000,
      });
      if (stdout.trim() === "ok") {
        pyOk = true;
        pyDetail = `${py} — fastapi · uvicorn · joblib · scikit-learn ready`;
        break;
      }
    } catch {
      /* try next candidate (ENOENT or missing packages) */
    }
  }
  L.push(`  ${pyOk ? "●" : "○"} python runtime  ML stack                   ${pyDetail}`);

  // 5 — remote python job radar (cache/board registry)
  const snap = cachedSnapshot();
  const boards = VERIFIED_BOARDS.filter((b) => b.live).length;
  L.push(
    `  ● job radar      Remote Python Fresher         ${boards} live boards · ${
      snap ? `${snap.roles} roles cached (${snap.source} · ${snap.at})` : "cache cold — open the Remote Python tab"
    }`,
  );

  // 6 — workspace + system
  L.push(`  ● workspace      ${workspace}`);
  L.push(`    host           ${system}`);
  L.push(`  done in ${Date.now() - t0}ms — the console IS the sandbox: type freely.`);
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────
// POST /api/agent/terminal — run a command the USER typed into the
// xterm console: built-ins answer inline, everything else runs in
// the SAME sandboxed shell tool the agent uses (validateCommand
// blocklist, relative paths only, timeouts, output caps). Output
// streams to every connected terminal via the bus.
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { command?: unknown };
    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) {
      return NextResponse.json({ error: "command is required" }, { status: 400 });
    }
    if (command.length > 400) {
      return NextResponse.json({ error: "command too long (max 400 chars)" }, { status: 400 });
    }

    terminalLine("user", command);

    // built-ins — answered without touching the shell
    if (command === "help" || command === "status") {
      const t0 = Date.now();
      const out = command === "help" ? helpText() : await statusText();
      terminalLine("out", out);
      return NextResponse.json({ ok: true, exitCode: 0, durationMs: Date.now() - t0, output: out });
    }
    const result = (await executeCodingTool("shell_run", { command, timeout_seconds: 60 })) as {
      error?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      durationMs?: number;
      timedOut?: boolean;
      background?: boolean;
      pid?: number | null;
      logFile?: string | null;
    };

    let out: string;
    if (result.error) {
      out = `error: ${result.error}`;
    } else if (result.background) {
      out = `[background] pid ${result.pid ?? "?"} · log ${result.logFile ?? "?"}`;
    } else {
      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout.slice(0, 8000));
      if (result.stderr) parts.push(result.stderr.slice(0, 2000));
      out =
        parts.join("\n").trim() ||
        `(no output — exit code ${result.exitCode ?? "?"}${result.timedOut ? " (timed out)" : ""})`;
    }
    terminalLine("out", out);

    return NextResponse.json({
      ok: !result.error,
      exitCode: result.exitCode ?? null,
      durationMs: result.durationMs ?? null,
      output: out,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
