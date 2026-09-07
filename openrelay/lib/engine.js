'use strict';
// ─────────────────────────────────────────────────────────────────
// OpenRelay rotation engine — THE never-fail loop.
//
//   step  = one (entry, model) pair; the chain expands to an ordered
//           list of steps: 1, 2, 3 … N (config order IS priority).
//   round = one full pass through the steps.
//
// Rotation contract ("1 fails → 2 → 3 … → N → back to 1"):
//   • a failed attempt advances to the NEXT step instantly
//   • bad_model/auth failures also blacklist that step for THIS
//     request (no repeat within one request's lifetime)
//   • when a whole round fails, the engine sleeps an exponentially
//     growing, full-jitter delay (roundBase → roundMax) and wraps
//     back to step 1 — "when it comes to the end, the 1st one will
//     be free" (its breaker cooldown / Retry-After has expired by
//     then, and the free/local tail keeps absorbing bursts)
//   • rate-limited entries get a short breaker cooldown (no trip),
//     so they rejoin the rotation exactly when they are free again
//   • every step that answers ends the loop — meta reports the
//     survivor, the attempts and the rounds it took
//   • the only exits are SUCCESS or RelayExhaustedError after
//     deadlineMs / maxRounds — never a single provider's error
//
// Streaming uses FIRST-CHUNK GATING: nothing is forwarded to the
// client until the upstream produced a real data line, so any
// failure before the first token fails over SILENTLY. A failure
// after bytes were forwarded cannot be retried (the client already
// has partial output) — it terminates that stream with a typed
// error event and the client's next request rotates to a healthy
// step.
// ─────────────────────────────────────────────────────────────────
const { ApiError, callUpstream, sseLines } = require('./providers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fullJitter = (exp) => Math.floor(exp / 2 + Math.random() * (exp / 2));

class RelayExhaustedError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'RelayExhaustedError';
    this.kind = 'exhausted';
    this.detail = detail; // {attempts, rounds, failures[], elapsedMs}
  }
}

class Engine {
  constructor({ config, steps, breaker, queue, usage, log }) {
    this.cfg = config;
    this.steps = steps;          // [{key, rank, entry, model}]
    this.breaker = breaker;
    this.queue = queue;
    this.usage = usage;
    this.log = log || (() => {});
    this.rotation = Object.assign(
      { roundBaseMs: 2000, roundMaxMs: 30000, maxRounds: 0, deadlineMs: 120000 },
      config.rotation || {}
    );
  }

  setSteps(steps) { this.steps = steps; }

  /** Steps rotated so the requested model's step leads (model-bar
   *  semantics: pick any model as primary, the chain still backs
   *  it up). 'openrelay/auto' / unknown → config order. */
  orderFor(model) {
    if (!model || model === 'openrelay/auto') return this.steps;
    const idx = this.steps.findIndex((s) => s.model === model);
    if (idx <= 0) return this.steps;
    return this.steps.slice(idx).concat(this.steps.slice(0, idx));
  }

  /**
   * Relay one request.
   * ctx (streaming only): { signal, beginStream(), onChunk(line),
   *                         endStream(meta), streamFailure(err) }
   * Resolves { ok:true, json?, usage?, meta } or throws
   * RelayExhaustedError. Mid-stream failure resolves
   * { ok:false, midStream:true, error, meta }.
   */
  async relay(body, ctx = {}) {
    const started = Date.now();
    const order = this.orderFor(body.model);
    // Hard 4xx walls (bad_model / auth) blacklist a step — but only
    // until TWO rounds later, when it is FREE TO TRY AGAIN (the
    // literal "when it comes to the end, the 1st one will be free"
    // contract): retrying costs one cheap request per wrap cycle.
    const deadSteps = new Map(); // stepKey → round it was blacklisted
    const lastFailureByStep = new Map(); // stepKey → last diagnosis line
    let attempts = 0;
    let round = 0;
    let waitExp = this.rotation.roundBaseMs;
    let lastError = null;

    for (;;) {
      round += 1;
      let attemptedThisRound = 0;

      for (const step of order) {
        if (Date.now() - started > this.rotation.deadlineMs) break;
        const bl = deadSteps.get(step.key);
        if (bl !== undefined && round - bl < 2) continue; // still blacklisted this round

        const g = this.breaker.gate(step.entry.id);
        if (!g.ok) continue;
        const isProbe = Boolean(g.probe);
        if (isProbe) this.breaker.beginProbe(step.entry.id);

        attemptedThisRound += 1;
        attempts += 1;
        const release = await this.queue.acquire(step.entry.id);
        const t0 = Date.now();
        try {
          const out = await this.attempt(step, body, ctx, { attempts, round });
          this.breaker.success(step.entry.id);
          this.usage.record(step, true, null, Date.now() - t0, out.usage);
          this.usage.rotation({ round, step: step.key, ok: true, ms: Date.now() - t0, probe: isProbe });
          const meta = {
            step: step.key,
            entry: step.entry.id,
            model: step.model,
            attempts,
            round,
            elapsedMs: Date.now() - started,
          };
          if (out.midStream) {
            return { ok: false, midStream: true, error: out.error, meta };
          }
          return { ok: true, json: out.json, usage: out.usage, meta };
        } catch (e) {
          lastError = e;
          const kind = e instanceof ApiError ? e.kind : 'server';
          this.breaker.failure(step.entry.id, kind, e.message, e.retryAfterMs);
          this.usage.record(step, false, e, Date.now() - t0);
          this.usage.rotation({ round, step: step.key, ok: false, kind, err: String(e.message || e).slice(0, 200), probe: isProbe });
          lastFailureByStep.set(step.key, `[${kind}] ${String(e.message || e).slice(0, 160)}`);
          if (kind === 'bad_model' || kind === 'auth') deadSteps.set(step.key, round);
          this.log('relay', `${round}·${step.key} ${kind} → rotating`);
        } finally {
          release();
        }
      }

      if (this.rotation.maxRounds > 0 && round >= this.rotation.maxRounds) {
        throw this.exhausted(attempts, round, lastFailureByStep, order, Date.now() - started, lastError);
      }
      if (Date.now() - started > this.rotation.deadlineMs) {
        throw this.exhausted(attempts, round, lastFailureByStep, order, Date.now() - started, lastError);
      }

      // Everything tripped mid-round → sleep until the earliest
      // breaker recovers instead of spinning the CPU.
      let wait;
      if (attemptedThisRound === 0) {
        const rec = this.breaker.minRecoveryMs(this.steps.map((s) => s.entry.id));
        wait = Math.min(Math.max(rec > 0 ? rec : waitExp, 500), 30000);
      } else {
        wait = fullJitter(Math.min(waitExp, this.rotation.roundMaxMs));
        waitExp = Math.min(waitExp * 2, this.rotation.roundMaxMs);
      }
      const reFree = (s) => { const bl = deadSteps.get(s.key); return bl === undefined || round - bl >= 2; };
      const nextFirst = (order.find(reFree) || order[0]).key;
      this.usage.rotation({ round, wrap: true, waitMs: wait, nextFirst });
      this.log('relay', `round ${round} exhausted all steps — wrap-around: back to ${nextFirst} in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }

  exhausted(attempts, round, lastFailureByStep, order, elapsedMs, lastError) {
    // Diagnosis carries EVERY step's last known state across all
    // rounds (a step skipped in the final round still reports why it
    // originally failed — the map survives round resets).
    const failures = order.map((s) =>
      lastFailureByStep.has(s.key)
        ? `${s.key}: ${lastFailureByStep.get(s.key)}`
        : `${s.key}: never attempted (breaker open / blacklisted)`
    );
    return new RelayExhaustedError(
      `OpenRelay exhausted: ${attempts} attempts over ${round} round(s) in ${Math.round(elapsedMs / 100) / 10}s — every step refused. Last error: ${String(lastError && lastError.message ? lastError.message : lastError).slice(0, 200)}`,
      { attempts, rounds: round, failures, elapsedMs }
    );
  }

  /** One attempt against one step. Streams via ctx when body.stream. */
  async attempt(step, body, ctx, meta) {
    const res = await callUpstream(step.entry, step.model, body, {
      timeoutMs: (this.cfg.request && this.cfg.request.timeoutMs) || 180000,
      signal: ctx.signal,
    });

    if (!body.stream) {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        throw new ApiError('server', 200, `${step.entry.id} · ${step.model}: non-JSON 200 response: ${text.slice(0, 200)}`);
      }
      if (json && json.error) {
        throw new ApiError('server', json.error.code || 200, `${step.entry.id} · ${step.model}: embedded error: ${JSON.stringify(json.error).slice(0, 300)}`);
      }
      return { json, usage: json.usage };
    }

    // ── streaming with first-chunk gating ──────────────────────
    let began = false;
    let usage = null;
    let sawDone = false;
    const forward = (line) => { if (began) ctx.onChunk(line); };
    try {
      for await (const { line, json } of sseLines(res, step.entry.id)) {
        if (json === '[DONE]') {
          sawDone = true;
          if (!began) { began = true; ctx.beginStream(); } // degenerate stream
          forward(line);
          continue;
        }
        if (json && typeof json === 'object') {
          if (json.error) {
            throw new ApiError('server', json.error.code || 200, `${step.entry.id} · ${step.model}: embedded stream error: ${JSON.stringify(json.error).slice(0, 300)}`, { midStream: began });
          }
          if (json.usage) usage = json.usage;
        }
        if (!began && line.trim() !== '') {
          began = true;
          ctx.beginStream();
        }
        forward(line);
      }
      if (!sawDone) {
        // upstream closed without [DONE] — treat as truncation; if
        // nothing was forwarded yet, fail over; else report mid-stream.
        throw new ApiError('server', 200, `${step.entry.id} · ${step.model}: stream ended without [DONE]`, { midStream: began });
      }
      ctx.endStream({
        step: step.key,
        entry: step.entry.id,
        model: step.model,
        attempts: meta.attempts,
        round: meta.round,
        usage: usage || undefined,
      });
      return { usage, streamDone: true };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError('network', 0, `${step.entry.id}: ${e && e.message ? e.message : String(e)}`);
      err.midStream = began || err.midStream;
      if (err.midStream) {
        // bytes already delivered — cannot rotate; surface cleanly
        ctx.streamFailure(err, { step: step.key, model: step.model });
        return { midStream: true, error: err };
      }
      throw err; // before first chunk → silent failover
    }
  }
}

module.exports = { Engine, RelayExhaustedError };
