'use strict';
// ─────────────────────────────────────────────────────────────────
// OpenRelay circuit breaker — per-provider-entry health with
// PERSISTENT FAILOVER MEMORY: state survives restarts (state/
// breaker.json), so a provider that was tripping before the restart
// is still cooling down after it.
//
// Policy (per entry id):
//   CLOSED      → healthy, serving
//   OPEN        → cooling down (skip instantly, no wasted round-trip)
//   HALF-OPEN   → cooldown expired → exactly ONE probe request; a
//                 success closes, a failure re-opens LONGER
//
// Failure weighting by kind:
//   auth          → counts x3 (a dead key should trip after 1 hit)
//   server        → counts x1
//   network       → counts x1
//   timeout       → counts x1
//   bad_model     → counts x1 (usually model-level, the engine also
//                   blacklists the model for the current request)
//   rate_limited  → NO trip: just a short cooldown honoring
//                   Retry-After (the provider is healthy, just busy)
// ─────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

function freshCell() {
  return {
    failures: [],       // timestamps of counted failures (sliding window)
    openUntil: 0,       // epoch ms; > now → OPEN
    trips: 0,           // lifetime trips (drives exponential cooldown)
    probeInFlight: false,
    lastError: null,
    lastErrorAt: 0,
    lastSuccessAt: 0,
    consecutiveFailures: 0,
  };
}

class Breaker {
  constructor(cfg, stateFile) {
    this.cfg = Object.assign(
      { failureThreshold: 3, windowMs: 120000, cooldownMs: 60000, maxCooldownMs: 900000 },
      cfg || {}
    );
    this.stateFile = stateFile;
    this.cells = new Map();
    this._saveTimer = null;
    this._load();
  }

  cell(id) {
    let c = this.cells.get(id);
    if (!c) { c = freshCell(); this.cells.set(id, c); }
    return c;
  }

  /** Can this entry be tried right now? {ok, probe, remainingMs} */
  gate(id) {
    const c = this.cell(id);
    const now = Date.now();
    if (c.openUntil && now < c.openUntil) return { ok: false, probe: false, remainingMs: c.openUntil - now };
    if (c.openUntil && now >= c.openUntil) {
      if (c.probeInFlight) return { ok: false, probe: false, remainingMs: 0 };
      return { ok: true, probe: true, remainingMs: 0 }; // half-open probe
    }
    return { ok: true, probe: false, remainingMs: 0 };
  }

  beginProbe(id) { this.cell(id).probeInFlight = true; }

  /** How long until the earliest OPEN entry recovers (for sleep-all-open). */
  minRecoveryMs(ids) {
    const now = Date.now();
    let min = Infinity;
    for (const id of ids) {
      const c = this.cell(id);
      if (c.openUntil && c.openUntil > now) min = Math.min(min, c.openUntil - now);
    }
    return Number.isFinite(min) ? min : -1;
  }

  failure(id, kind, message, retryAfterMs) {
    const c = this.cell(id);
    const now = Date.now();
    c.lastError = String(message || kind || 'error').slice(0, 300);
    c.lastErrorAt = now;
    c.probeInFlight = false;

    if (kind === 'rate_limited') {
      // healthy provider, just busy: short cooldown, no trip growth
      const wait = Math.min(Math.max(retryAfterMs || 20000, 2000), 60000);
      c.openUntil = Math.max(c.openUntil, now + wait);
      this._save();
      return;
    }

    c.failures = c.failures.filter((t) => now - t < this.cfg.windowMs);
    c.failures.push(now);
    if (kind === 'auth') c.failures.push(now, now); // dead key → trip on first hit
    c.consecutiveFailures += 1;

    if (c.failures.length >= this.cfg.failureThreshold) {
      c.trips += 1;
      const cooldown = Math.min(
        this.cfg.cooldownMs * Math.pow(2, c.trips - 1),
        this.cfg.maxCooldownMs
      );
      c.openUntil = now + cooldown;
      c.failures = [];
    }
    this._save();
  }

  success(id) {
    const c = this.cell(id);
    c.failures = [];
    c.openUntil = 0;
    c.trips = 0;
    c.consecutiveFailures = 0;
    c.probeInFlight = false;
    c.lastSuccessAt = Date.now();
    this._save();
  }

  reset(id) { this.cells.delete(id); this._save(); }

  snapshotEntry(id) {
    const c = this.cell(id);
    const g = this.gate(id);
    return {
      state: c.openUntil === 0 ? 'closed' : (g.ok ? 'half-open' : 'open'),
      remainingMs: g.remainingMs,
      trips: c.trips,
      consecutiveFailures: c.consecutiveFailures,
      lastError: c.lastError,
      lastErrorAt: c.lastErrorAt || null,
      lastSuccessAt: c.lastSuccessAt || null,
    };
  }

  // ── persistence (failover memory) ────────────────────────────
  _load() {
    try {
      if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const now = Date.now();
      for (const [id, raw] of Object.entries(data)) {
        const c = freshCell();
        Object.assign(c, {
          trips: raw.trips || 0,
          lastError: raw.lastError || null,
          lastErrorAt: raw.lastErrorAt || 0,
          lastSuccessAt: raw.lastSuccessAt || 0,
          consecutiveFailures: raw.consecutiveFailures || 0,
          // keep the cooldown ACROSS restarts, but not forever
          openUntil: raw.openUntil && raw.openUntil > now ? raw.openUntil : 0,
        });
        this.cells.set(id, c);
      }
    } catch { /* corrupt state file → start clean */ }
  }

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        const out = {};
        for (const [id, c] of this.cells) {
          out[id] = {
            trips: c.trips,
            openUntil: c.openUntil,
            lastError: c.lastError,
            lastErrorAt: c.lastErrorAt,
            lastSuccessAt: c.lastSuccessAt,
            consecutiveFailures: c.consecutiveFailures,
          };
        }
        fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
        fs.writeFileSync(this.stateFile, JSON.stringify(out, null, 2));
      } catch { /* disk issues never kill the relay */ }
    }, 300);
  }
}

module.exports = { Breaker };
