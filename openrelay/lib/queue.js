'use strict';
// ─────────────────────────────────────────────────────────────────
// OpenRelay request queue — global concurrency cap + per-entry cap.
//
// One in-flight request may hold a slot while it ROTATES through
// providers, so the cap protects the process (event loop, sockets)
// rather than serializing users. Waiters are fair FIFO and depth is
// reported live to /stats for the dashboard queue badge.
// ─────────────────────────────────────────────────────────────────

class Queue {
  constructor(cfg) {
    const c = Object.assign({ maxConcurrent: 8, perEntry: 2 }, cfg || {});
    this.maxConcurrent = c.maxConcurrent;
    this.perEntry = c.perEntry;
    this.global = 0;
    this.per = new Map();
    this.waiting = [];
    this.totalAcquired = 0;
    this.totalWaitedMs = 0;
  }

  /** Resolve when a slot is available; returns a release() function. */
  async acquire(entryId) {
    const enqueueAt = Date.now();
    for (;;) {
      const per = this.per.get(entryId) || 0;
      if (this.global < this.maxConcurrent && per < this.perEntry) {
        this.global += 1;
        this.per.set(entryId, per + 1);
        this.totalAcquired += 1;
        const waited = Date.now() - enqueueAt;
        if (waited > 5) this.totalWaitedMs += waited;
        return () => this.release(entryId);
      }
      await new Promise((resolve) => this.waiting.push(resolve));
    }
  }

  release(entryId) {
    this.global = Math.max(0, this.global - 1);
    this.per.set(entryId, Math.max(0, (this.per.get(entryId) || 1) - 1));
    if (this.per.get(entryId) === 0) this.per.delete(entryId);
    const next = this.waiting.shift();
    if (next) next(); // the woken waiter re-checks its conditions
  }

  stats() {
    return {
      inflight: this.global,
      depth: this.waiting.length,
      maxConcurrent: this.maxConcurrent,
      perEntry: this.perEntry,
      totalAcquired: this.totalAcquired,
      avgWaitMs: this.totalAcquired ? Math.round(this.totalWaitedMs / this.totalAcquired) : 0,
      perEntryInflight: Object.fromEntries(this.per),
    };
  }
}

module.exports = { Queue };
