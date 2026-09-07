// GET /api/preview/events — the LIVE PREVIEW SSE channel.
//
// Two layers, same stream:
//   • Layer 1 (instant): the agent event bus — every fs_write /
//     fs_edit / fs_batch / fs_copy / fs_move publishes on the
//     "preview" channel; this route forwards it as
//     `event: write {path, ts}` the same millisecond. The runtime
//     injected into previewed pages reloads itself on arrival.
//   • Layer 2 (safety net, 1.5 s): a workspace signature poll
//     (fileCount:totalBytes:maxMtime) — catches writes made OUTSIDE
//     the agent (by hand, by shell, by editors) and emits
//     `event: stats {sig}` so the Studio refreshes its tree and
//     remounts the webview.
//
// CORS: `access-control-allow-origin: *` — the webview iframe runs
// sandboxed (opaque origin, scripts allowed, no same-origin), so
// its EventSource needs a permissive CORS header to connect.
// Heartbeat every 15 s; retired after 10 min (EventSource and the
// React hook both reconnect automatically).

import { NextRequest } from "next/server";
import { buildWorkspaceTree } from "@/lib/workspace";
import { PREVIEW_CHANNEL } from "@/lib/preview";
import { subscribe, type AgentBusEvent } from "@/lib/agent/event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const POLL_MS = 1500;
const PING_MS = 15_000;
const RETIRE_MS = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSig = "";
      let polling = false;

      const send = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(pollTimer);
        clearInterval(pingTimer);
        clearTimeout(retireTimer);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Layer 1 — instant agent writes from the bus
      const onBusEvent = (e: AgentBusEvent) => {
        if (e.type === "write" && e.data) {
          const payload = e.data as { path?: unknown; ts?: unknown };
          send("write", { path: typeof payload.path === "string" ? payload.path : "", ts: e.ts });
        }
      };
      const unsubscribe = subscribe([PREVIEW_CHANNEL], onBusEvent);

      // Layer 2 — signature poll (external writes safety net)
      const signature = (meta: { fileCount: number; totalBytes: number; tree: Array<{ mtime: number; children?: unknown[] }> }) =>
        `${meta.fileCount}:${meta.totalBytes}:${maxMtimeOf(meta.tree)}`;
      const poll = async () => {
        if (closed || polling || req.signal.aborted) return;
        polling = true;
        try {
          const meta = await buildWorkspaceTree();
          const sig = signature(meta);
          if (sig !== lastSig) {
            const first = lastSig === "";
            lastSig = sig;
            send("stats", { sig, ts: Date.now(), ...(first ? { hello: true } : {}) });
          }
        } catch {
          /* tree read failed — next tick retries */
        } finally {
          polling = false;
        }
      };
      void poll(); // hello + baseline signature immediately
      const pollTimer = setInterval(() => void poll(), POLL_MS);

      // heartbeat so proxies keep the stream open
      const pingTimer = setInterval(() => send("ping", { ts: Date.now() }), PING_MS);

      // safety valve
      const retireTimer = setTimeout(() => {
        send("retired", { ts: Date.now() });
        close();
      }, RETIRE_MS);

      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      // the sandboxed webview has an opaque origin — allow it to connect
      "access-control-allow-origin": "*",
    },
  });
}

function maxMtimeOf(nodes: Array<{ mtime?: number; children?: unknown[] }>): number {
  let best = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop() as { mtime?: number; children?: unknown[] };
    const m = Number(n.mtime ?? 0);
    if (m > best) best = m;
    if (Array.isArray(n.children)) stack.push(...(n.children as Array<typeof n>));
  }
  return best;
}
