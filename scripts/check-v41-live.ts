// Inspect the bus ring for the REAL multi-provider run's live events.
import { replay } from "../src/lib/agent/event-bus";
const term = replay("terminal", 0, 400);
const retryLines = term.filter((e) => (e.text ?? "").includes("↺") || (e.text ?? "").includes("⚠") || (e.text ?? "").includes("queued"));
console.log("RETRY/QUEUE/BREAKER LINES ON THE LIVE TERMINAL:");
for (const e of retryLines.slice(-8)) console.log("  ", (e.text ?? "").slice(0, 140));
const roundLines = term.filter((e) => e.kind === "round").map((e) => e.text ?? "");
console.log(`\nROUND LINES (${roundLines.length}):`);
for (const r of roundLines.slice(-4)) console.log("  ", r.slice(0, 140));
const thinkLines = term.filter((e) => (e.text ?? "").includes("reasoning")).map((e) => e.text ?? "");
console.log(`\nREASONING SUMMARY LINES (${thinkLines.length}):`);
for (const t of thinkLines.slice(-3)) console.log("  ", t.slice(0, 140));
