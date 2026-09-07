// ─────────────────────────────────────────────────────────────
// v4.0 AGENT EVENT BUS — the real-time backbone.
//
// The v3.x SSE route polled the database once a second, which
// meant the UI only learned about a round AFTER it finished —
// during a 30s Groq round the console looked frozen ("prompt is
// running but nothing moves"). This bus fixes that: the LLM
// layer and the runner now PUBLISH token-by-token deltas, round
// stats, usage and tool events the instant they happen, and the
// SSE routes SUBSCRIBE and push them to the browser with zero
// polling latency.
//
// Design (openclaude QueryEngine-inspired, deterministic):
//   • single in-process global (survives Next.js hot reloads the
//     same way the busy-lock global does)
//   • ring buffer per channel for REPLAY: a browser that
//     reconnects (or opens late) asks for everything after a
//     sequence number and misses nothing — no reload needed
//   • channels: "run:<runId>" (deltas/usage/rounds for one run)
//     and "terminal" (the xterm.js live console feed)
//   • listeners never throw into the publisher (broken SSE
//     clients are dropped silently)
// ─────────────────────────────────────────────────────────────

export interface AgentBusEvent {
  /** Monotonic sequence number — reconnect cursors use this. */
  seq: number;
  ts: number;
  channel: string;
  type: string;
  /** Terminal line category ("round" | "tool" | "result" | …). */
  kind?: string;
  text?: string;
  data?: Record<string, unknown>;
}

type Listener = (event: AgentBusEvent) => void;

interface BusState {
  seq: number;
  ring: AgentBusEvent[];
  listeners: Map<number, { channels: Set<string>; fn: Listener }>;
  nextSub: number;
}

const RING_MAX = 900;
const REPLAY_MAX = 400;

const BUS_KEY = "__agentEventBus";
const g = globalThis as unknown as Record<string, unknown>;

function state(): BusState {
  let s = g[BUS_KEY] as BusState | undefined;
  if (!s) {
    s = { seq: 0, ring: [], listeners: new Map(), nextSub: 1 };
    g[BUS_KEY] = s;
  }
  return s;
}

/** Publish an event to a channel. Synchronous, never throws. */
export function publish(
  channel: string,
  type: string,
  payload?: { kind?: string; text?: string; data?: Record<string, unknown> }
): AgentBusEvent {
  const s = state();
  const event: AgentBusEvent = {
    seq: ++s.seq,
    ts: Date.now(),
    channel,
    type,
    ...(payload?.kind !== undefined ? { kind: payload.kind } : {}),
    ...(payload?.text !== undefined ? { text: payload.text } : {}),
    ...(payload?.data ? { data: payload.data } : {}),
  };
  s.ring.push(event);
  if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX);
  for (const sub of s.listeners.values()) {
    if (!sub.channels.has(channel)) continue;
    try {
      sub.fn(event);
    } catch {
      /* a dead SSE client must never break the agent loop */
    }
  }
  return event;
}

/** Subscribe to channels; returns an unsubscribe function. */
export function subscribe(channels: string[], fn: Listener): () => void {
  const s = state();
  const id = s.nextSub++;
  s.listeners.set(id, { channels: new Set(channels), fn });
  return () => {
    s.listeners.delete(id);
  };
}

/** Replay buffered events on a channel newer than `afterSeq`. */
export function replay(channel: string, afterSeq = 0, max = REPLAY_MAX): AgentBusEvent[] {
  const s = state();
  const events: AgentBusEvent[] = [];
  for (let i = s.ring.length - 1; i >= 0 && events.length < max; i--) {
    const e = s.ring[i];
    if (e.channel === channel && e.seq > afterSeq) events.unshift(e);
    // older-than-cursor events can be skipped once we pass the cursor
    if (e.seq <= afterSeq) break;
  }
  return events;
}

/** Current global sequence — "give me everything from now on". */
export function currentSeq(): number {
  return state().seq;
}

// ── Typed helpers (the only publishers in the codebase) ──────

/** Live token fragment from a streaming provider (run channel). */
export function publishDelta(runId: string, text: string): void {
  publish(`run:${runId}`, "delta", { text });
}

/** v4.1 — live chain-of-thought fragment from a thinking model
 *  (NVIDIA reasoning_content / OpenRouter reasoning), on its own
 *  channel so the answer text stays clean. */
export function publishReasoning(runId: string, text: string): void {
  publish(`run:${runId}`, "reasoning", { text });
}

/** Round stat + usage detail (run channel → usage meters). */
export function publishUsage(
  runId: string,
  data: {
    round: number;
    provider: string;
    model?: string;
    tokens: number;
    cumulative: number;
    usage?: Record<string, unknown>;
  }
): void {
  publish(`run:${runId}`, "usage", { data });
}

/** A line for the xterm.js live console. */
export function terminalLine(
  kind:
    | "sys" | "goal" | "round" | "assistant" | "tool" | "result" | "note"
    | "handoff" | "usage" | "final" | "error" | "user" | "out",
  text: string
): void {
  publish("terminal", "line", { kind, text });
}
