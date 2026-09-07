// E2E agent loop test — runs a REAL goal through runAgentToCompletion
import { runAgentToCompletion } from "../src/lib/agent/runner";
import { db } from "../src/lib/db";

const goal =
  "Search live ML/AI internships and entry-level roles in India (role track ml, location india), score them, add the best 2 to my tracker with match reasoning notes, then report what you added with real URLs.";

console.log("GOAL:", goal, "\n");
const t0 = Date.now();
const out = await runAgentToCompletion(goal, "manual");
console.log(`\n=== RUN FINISHED in ${((Date.now() - t0) / 1000).toFixed(0)}s ===`);
console.log("status:", out.status, "| provider:", out.provider, "| steps:", out.stepLog.length);
console.log("\nSTEP LOG:");
for (const s of out.stepLog) console.log("  " + s);
console.log("\nFINAL REPORT:\n" + out.result.slice(0, 1500));

const apps = await db.application.findMany();
console.log(`\n=== TRACKER ROWS: ${apps.length} ===`);
for (const a of apps) {
  console.log(`  ${a.company} — ${a.role} [${a.status}] ${a.jobUrl ?? ""}`);
  if (a.notes) console.log(`    notes: ${a.notes.slice(0, 160)}`);
}
