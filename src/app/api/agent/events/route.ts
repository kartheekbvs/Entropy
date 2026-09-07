import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { activeRunId } from "@/lib/agent/runner";
import { subscribe, replay, type AgentBusEvent } from "@/lib/agent/event-bus";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// GET /api/agent/events?id=…&since=<seq> — v3.7 real-time SSE stream,
// upgraded in v4.0 with a live BUS subscription.
//
// Layer 1 (v3.7, kept): a 1s DB poll pushes "update" the moment the
// transcript grows + "ping" heartbeats so the UI can show "thinking… Xs".
// Layer 2 (v4.0 NEW): the agent event bus pushes token DELTAS, usage
// and round stats the instant they happen — no polling latency, so a
// 30s Groq round is visibly alive the whole time.
//
// ?since=<seq> replays missed bus events after a reconnect (laptop
// sleep, tab switch) — nothing is lost without a page reload.
// The UI falls back to its existing polling if the stream drops.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? activeRunId();
  if (!id) {
    return new Response("no run id", { status: 404 });
  }
  const since = Number(req.nextUrl.searchParams.get("since") ?? "0") || 0;

  const encoder = new TextEncoder();
  const TICK_MS = 1000;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSignature = "";
      let lastStepTs = 0;
      let lastSeq = since;

      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearTimeout(retire);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Layer 2 — instant bus events (deltas, usage, rounds, handoffs).
      const sendBusEvent = (e: AgentBusEvent) => {
        if (e.seq <= lastSeq) return;
        lastSeq = e.seq;
        send({
          type: e.type,
          seq: e.seq,
          ts: e.ts,
          ...(e.kind !== undefined ? { kind: e.kind } : {}),
          ...(e.text !== undefined ? { text: e.text } : {}),
          ...(e.data ?? {}),
        });
      };

      // replay missed events after a reconnect, then go live
      try {
        for (const e of replay(`run:${id}`, since)) sendBusEvent(e);
      } catch {
        /* ring may be gone after a hot reload — live events resume below */
      }
      const unsubscribe = subscribe([`run:${id}`], sendBusEvent);

      // Layer 1 — DB poll: transcript signature + status + thinking timer.
      const timer = setInterval(async () => {
        if (closed || req.signal.aborted) {
          close();
          return;
        }
        try {
          const run = await db.agentRun.findUnique({ where: { id } });
          if (!run) {
            send({ type: "error", message: "run not found" });
            close();
            return;
          }
          const steps = JSON.parse(run.steps || "[]") as Array<{ ts?: number }>;
          const stepCount = steps.length;
          lastStepTs = steps.length > 0 ? Number(steps[steps.length - 1].ts ?? 0) : 0;
          const signature = `${stepCount}|${run.status}|${run.tokensUsed ?? 0}|${run.provider ?? ""}`;
          if (signature !== lastSignature) {
            const first = lastSignature === "";
            lastSignature = signature;
            send({
              type: "update",
              stepCount,
              status: run.status,
              tokensUsed: run.tokensUsed ?? 0,
              provider: run.provider ?? "",
              sinceStepMs: lastStepTs ? Date.now() - lastStepTs : 0,
              ...(first ? { hello: true } : {}),
            });
          } else {
            send({
              type: "ping",
              stepCount,
              status: run.status,
              sinceStepMs: lastStepTs ? Date.now() - lastStepTs : 0,
            });
          }
          if (run.status !== "running") {
            send({ type: "done", status: run.status, stepCount });
            close();
          }
        } catch {
          close();
        }
      }, TICK_MS);

      // Safety valve: never hold a stream open beyond 10 minutes.
      const retire = setTimeout(() => {
        send({ type: "timeout", message: "stream retired after 10 min — polling continues" });
        close();
      }, 10 * 60 * 1000);

      req.signal.addEventListener("abort", close);
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
