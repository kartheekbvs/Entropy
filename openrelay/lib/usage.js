'use strict';
// ─────────────────────────────────────────────────────────────────
// OpenRelay usage meter + rotation log — LIVE token accounting per
// step (entry × model) plus a ring buffer of every rotation event
// (attempt, failure, wrap-around) that the dashboard renders.
// Totals persist to state/usage.json (debounced) so counters survive
// restarts alongside the breaker memory.
// ─────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

class Usage {
  constructor(stateFile, { ringSize = 300, persistEveryMs = 4000 } = {}) {
    this.stateFile = stateFile;
    this.ringSize = ringSize;
    this.persistEveryMs = persistEveryMs;
    this.startedAt = Date.now();
    this.steps = new Map(); // stepKey → aggregates
    this.log = [];          // rotation events (newest last)
    this.totals = { requests: 0, ok: 0, fail: 0, rotations: 0, rounds: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    this._dirty = false;
    this._load();
    this._timer = setInterval(() => this._persistNow(), this.persistEveryMs);
    this._timer.unref?.();
  }

  _step(key) {
    let s = this.steps.get(key);
    if (!s) {
      s = { requests: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, cost: 0, latencyMsTotal: 0, lastLatencyMs: 0, lastError: null, lastAt: 0, lastOkAt: 0 };
      this.steps.set(key, s);
    }
    return s;
  }

  record(step, ok, err, ms, usage) {
    const s = this._step(step.key);
    s.requests += 1;
    this.totals.requests += 1;
    s.lastAt = Date.now();
    s.latencyMsTotal += ms;
    s.lastLatencyMs = ms;
    if (ok) {
      s.ok += 1;
      s.lastOkAt = Date.now();
      this.totals.ok += 1;
      const u = usage || {};
      const tin = u.prompt_tokens || u.promptTokens || 0;
      const tout = u.completion_tokens || u.completionTokens || 0;
      s.tokensIn += tin;
      s.tokensOut += tout;
      this.totals.tokensIn += tin;
      this.totals.tokensOut += tout;
      const cost = u.cost || (u.total_cost ? Number(u.total_cost) : 0) || 0;
      if (Number.isFinite(cost)) { s.cost += cost; this.totals.cost += cost; }
    } else {
      s.fail += 1;
      this.totals.fail += 1;
      s.lastError = String(err && err.message ? err.message : err || 'error').slice(0, 240);
    }
    this._dirty = true;
  }

  /** A rotation/attempt/wrap event for the live log. */
  rotation(event) {
    const e = Object.assign({ ts: Date.now() }, event);
    this.log.push(e);
    if (this.log.length > this.ringSize) this.log.splice(0, this.log.length - this.ringSize);
    if (e.wrap) { this.totals.rotations += 1; this.totals.rounds = Math.max(this.totals.rounds, e.round || 0); }
    else if (e.ok === false) this.totals.rotations += 1;
    this._dirty = true;
  }

  snapshot() {
    const steps = {};
    for (const [key, s] of this.steps) {
      steps[key] = Object.assign({}, s, {
        successRate: s.requests ? s.ok / s.requests : null,
        avgLatencyMs: s.requests ? Math.round(s.latencyMsTotal / s.requests) : null,
      });
    }
    return {
      totals: Object.assign({}, this.totals, {
        tokens: this.totals.tokensIn + this.totals.tokensOut,
        successRate: this.totals.requests ? this.totals.ok / this.totals.requests : null,
      }),
      steps,
      log: this.log.slice(-200),
      since: this.startedAt,
    };
  }

  // ── persistence ──────────────────────────────────────────────
  _load() {
    try {
      if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (data.totals) Object.assign(this.totals, data.totals);
      if (data.steps) for (const [k, v] of Object.entries(data.steps)) this.steps.set(k, v);
      if (Array.isArray(data.log)) this.log = data.log.slice(-this.ringSize);
    } catch { /* start clean */ }
  }

  _persistNow() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const steps = {};
      for (const [k, v] of this.steps) steps[k] = v;
      fs.writeFileSync(this.stateFile, JSON.stringify({ totals: this.totals, steps, log: this.log.slice(-100) }, null, 2));
    } catch { /* never fatal */ }
  }
}

module.exports = { Usage };
