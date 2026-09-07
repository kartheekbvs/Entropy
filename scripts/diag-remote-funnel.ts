// Diagnose the live funnel: per-board candidates + gate outcomes
import type { RawCandidate } from "../src/lib/jobs/remote-python";
import {
  normalizeRemotive, normalizeRemoteOk, normalizeWwrRss, normalizeHimalayas,
  normalizeJobicy, normalizePythonOrgRss, isSeniorTitle, hasFresherSignal,
  requiredYears,
} from "../src/lib/jobs/remote-python";

const UA = "Mozilla/5.0 (compatible; JobCommandCenter/4.5)";
async function jget(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
  return r.text();
}
function parseJsonSafe(t: string): unknown { try { return JSON.parse(t); } catch { return null; } }

const [rem, rok, wwr, him, job, py] = await Promise.all([
  jget("https://remotive.com/api/remote-jobs?search=python&limit=100").then(parseJsonSafe).then((d) => normalizeRemotive(d)),
  jget("https://remoteok.com/api").then(parseJsonSafe).then((d) => normalizeRemoteOk(d)),
  jget("https://weworkremotely.com/categories/remote-programming-jobs.rss").then((t) => normalizeWwrRss(t)),
  jget("https://himalayas.app/jobs/api?limit=100").then(parseJsonSafe).then((d) => normalizeHimalayas(d)),
  jget("https://jobicy.com/api/v2/remote-jobs?tag=python&count=50").then(parseJsonSafe).then((d) => normalizeJobicy(d)),
  jget("https://www.python.org/jobs/feed/rss/").then((t) => normalizePythonOrgRss(t)),
]);

const boards: [string, RawCandidate[]][] = [["remotive", rem], ["remoteok", rok], ["wwr", wwr], ["himalayas", him], ["jobicy", job], ["pythonorg", py]];

for (const [name, cands] of boards) {
  console.log(`\n=== ${name} (${cands.length} python candidates) ===`);
  for (const c of cands.slice(0, 30)) {
    const yrs = requiredYears(c.text);
    console.log(
      `  ${String(Math.round(c.ageDays)).padStart(3)}d ${c.worldwide ? "🌍" : "📍"} ${isSeniorTitle(c.title) ? "SR" : "  "} ${String(yrs).padStart(2)}y ${hasFresherSignal(c.title) ? "JR" : "  "} ${c.title.slice(0, 62).padEnd(62)} | ${c.company.slice(0, 18)}`
    );
  }
}

// gate outcomes at various age windows
for (const maxAge of [30, 60, 90]) {
  let pool: RawCandidate[] = [];
  for (const [, cands] of boards) {
    for (const c of cands) {
      const active = !isSeniorTitle(c.title) && c.ageDays <= maxAge && (requiredYears(c.text) <= 3 || hasFresherSignal(c.title));
      if (active) pool.push(c);
    }
  }
  const worldwide = pool.filter((c) => c.worldwide).length;
  console.log(`\nGATE maxAge=${maxAge}d → ${pool.length} pass (${worldwide} worldwide)`);
}
