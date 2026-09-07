// Smoke test for src/lib/agent/jobs-api.ts (run with bun)
import { searchPublicJobs, SOURCE_COUNT } from "../src/lib/agent/jobs-api";

async function main() {
  console.log(`sources registered: ${SOURCE_COUNT}`);
  const t0 = Date.now();
  const result = await searchPublicJobs({
    role: "ml",
    location: "india",
    limit: 10,
  });
  console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`totalFound: ${result.totalFound}`);
  console.log(`sources ok: ${result.sources.ok.length}, failed: ${result.sources.failed.length}`);
  if (result.sources.failed.length) console.log("failed:", result.sources.failed);
  console.log(`cached: ${result.sources.cached.length}`);
  for (const j of result.jobs.slice(0, 8)) {
    console.log(
      `  [${j.matchScore}] ${j.seniority.padEnd(6)} ${j.title} @ ${j.company} — ${j.location}`
    );
    console.log(`          ${j.url}`);
  }
  const remote = await searchPublicJobs({ role: "python", location: "remote", limit: 5 });
  console.log(`\nremote python totalFound: ${remote.totalFound}`);
  for (const j of remote.jobs.slice(0, 5)) {
    console.log(`  [${j.matchScore}] ${j.title} @ ${j.company} — ${j.location}`);
  }
  const cachedAgain = await searchPublicJobs({ role: "ml", location: "india", limit: 5 });
  console.log(`\ncache check (2nd call): ${cachedAgain.sources.cached.length}/${cachedAgain.sources.ok.length} sources cached`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
