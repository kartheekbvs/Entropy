// ─────────────────────────────────────────────────────────────
// v4.5 REMOTE PYTHON FRESHER RADAR — feature tests
//   1. UNITS  — heuristics (senior/fresher/years/worldwide),
//               RSS parsing, all 6 board normalizers, ranking
//               (dedupe, worldwide-first, limit cap, widen),
//               robust JSON extraction
//   2. CHAIN  — chain order (explabs gpt-oss FIRST, groq LAST),
//               403 geo-wall rotation, minimal-body 400 recovery,
//               all-fail → heuristic degradation, AI ordering
//   3. ROUTE  — GET /api/jobs/remote-python with mocked boards:
//               shape, cap, board-failure tolerance, never-500
//   4. LIVE   — the REAL boards + the owner's real keys
//               (skippable: LIVE=0)
//
// Run: bun scripts/test-v45.ts [all|units|chain|route|live]
// ─────────────────────────────────────────────────────────────
import { promises as fs } from "node:fs";
import {
  isSeniorTitle,
  hasFresherSignal,
  requiredYears,
  isWorldwide,
  parseRssItems,
  normalizeRemotive,
  normalizeRemoteOk,
  normalizeWwrRss,
  normalizeHimalayas,
  normalizeJobicy,
  normalizePythonOrgRss,
  rankCandidates,
  dedupeRoles,
  collectRemotePythonRoles,
  __resetRemotePythonCache,
  VERIFIED_BOARDS,
  type RawCandidate,
} from "../src/lib/jobs/remote-python";
import {
  buildAiChain,
  extractJson,
  rankRemoteRolesWithAI,
  applyVerdicts,
  __resetRemotePythonAiCache,
} from "../src/lib/jobs/remote-python-llm";

const failures: string[] = [];
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures.push(label);
}

const PHASE = (process.argv[2] ?? "all").toLowerCase();
const want = (p: string) => PHASE === "all" || PHASE === p;

// hermeticity: bun auto-loads .env with the owner's real keys — the mock
// phases must not talk to real providers
const REAL = {
  explabs: process.env.EXPLABS_API_KEY,
  groq: process.env.GROQ_API_KEY,
  or: process.env.OPENROUTER_API_KEY,
  nv: process.env.NVIDIA_API_KEY,
};
function mockKeys() {
  process.env.EXPLABS_API_KEY = "xpl-test-key";
  process.env.GROQ_API_KEY = "gsk-test-key";
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.NVIDIA_API_KEY = "nvapi-test";
}
function restoreKeys() {
  process.env.EXPLABS_API_KEY = REAL.explabs;
  process.env.GROQ_API_KEY = REAL.groq;
  process.env.OPENROUTER_API_KEY = REAL.or;
  process.env.NVIDIA_API_KEY = REAL.nv;
}

const DAY = 86_400_000;
const daysAgoIso = (n: number) => new Date(Date.now() - n * DAY).toISOString();

console.log("═".repeat(64));
console.log("v4.5 REMOTE PYTHON FRESHER RADAR TESTS");
console.log("═".repeat(64));

// ── PHASE 1: UNITS ────────────────────────────────────────────
if (want("units")) {
  console.log("\n── 1. UNITS ──");
  mockKeys();
  process.env.REMOTE_PYTHON_MAX_AGE_DAYS = "30";
  __resetRemotePythonCache();

  check("senior title detected", isSeniorTitle("Senior Python Engineer"));
  check("principal/staff detected", isSeniorTitle("Staff Python Developer") && isSeniorTitle("Lead Python Dev"));
  check("plain title NOT senior", !isSeniorTitle("Python Developer"));
  check("junior title detected", hasFresherSignal("Junior Python Developer"));
  check("entry-level detected", hasFresherSignal("Entry-Level Backend Engineer (Python)"));
  check("graduate/trainee detected", hasFresherSignal("Graduate Trainee — Python"));
  check("plain title NOT fresher signal", !hasFresherSignal("Python Developer"));
  check("years parsed '3+ years'", requiredYears("requires 3+ years of experience") === 3);
  check("years parsed '2-4 years'", requiredYears("2-4 years building APIs") === 2);
  check("no years → 0", requiredYears("loves python") === 0);
  check("worldwide 'Anywhere'", isWorldwide("Anywhere", null));
  check("worldwide 'Worldwide'", isWorldwide("Worldwide", null));
  check("restricted not worldwide", !isWorldwide("US only", null));
  check("empty restrictions = worldwide (himalayas)", isWorldwide("", []) && !isWorldwide("", ["United States"]));

  // RSS parsing (WWR-style with CDATA)
  const wwrXml = `<?xml version="1.0"?><rss><channel><title>We Work Remotely</title>
<item><title><![CDATA[Junior Python Developer (Anywhere in the World)]]></title><link>https://weworkremotely.com/remote-jobs/junior-python-1</link><pubDate>${new Date(Date.now() - 2 * DAY).toUTCString()}</pubDate><description><![CDATA[<p>Looking for a junior python dev. 1+ years of Django.</p>]]></description></item>
<item><title><![CDATA[Senior Python Engineer (US only)]]></title><link>https://weworkremotely.com/remote-jobs/senior-python-2</link><pubDate>${new Date(Date.now() - 1 * DAY).toUTCString()}</pubDate><description><![CDATA[<p>8+ years.</p>]]></description></item>
</channel></rss>`;
  const wwrItems = parseRssItems(wwrXml);
  check("RSS parses 2 items with CDATA", wwrItems.length === 2 && wwrItems[0].title.includes("Junior Python"));
  const wwrRoles = normalizeWwrRss(wwrXml);
  check("WWR keeps python items (senior dropped at ranking)", wwrRoles.length === 2 && wwrRoles.some((r) => /senior/i.test(r.title)));
  check("WWR worldwide from title", wwrRoles[0].worldwide === true);
  check("WWR parens stripped from title", wwrRoles[0].title === "Junior Python Developer");

  // python.org RSS ("Title at Company (Location)")
  const pyXml = `<?xml version="1.0"?><rss><channel>
<item><title>Junior Python Developer at Acme Corp (Anywhere)</title><link>https://www.python.org/jobs/912/</link><pubDate>${new Date(Date.now() - DAY).toUTCString()}</pubDate><description><![CDATA[Remote (Anywhere)<p>entry level python role</p>]]></description></item>
<item><title>Data Engineer, Beta Ltd</title><link>https://www.python.org/jobs/913/</link><pubDate>${new Date(Date.now() - DAY).toUTCString()}</pubDate><description><![CDATA[Remote - Berlin<p>senior data pipelines</p>]]></description></item>
<item><title>Backend Software Engineer (FastAPI), Gamma GmbH</title><link>https://www.python.org/jobs/914/</link><pubDate>${new Date(Date.now() - DAY).toUTCString()}</pubDate><description><![CDATA[Onsite in Katy, Texas<p>python</p>]]></description></item>
</channel></rss>`;
  const pyRoles = normalizePythonOrgRss(pyXml);
  check("python.org: comma titles parsed (company split)", pyRoles.length === 2 && pyRoles[0].company === "Acme Corp" && pyRoles[1].company === "Beta Ltd");
  check("python.org: onsite listing excluded", !pyRoles.some((r) => /onsite/i.test(r.title) || r.id === "pythonorg:914"));
  check("python.org location parsed", pyRoles[0].location === "Anywhere" || /Anywhere|Remote/i.test(pyRoles[0].location));
  check("python.org worldwide flag", pyRoles[0].worldwide === true);
  check("python.org curated feed: age unknown, presence = active", pyRoles[0].ageUnknown === true && pyRoles[0].ageDays === 0);

  // JSON board normalizers
  const remotiveRoles = normalizeRemotive({
    jobs: [
      { title: "Junior Python Developer", company_name: "Acme", candidate_required_location: "Anywhere", url: "https://remotive.com/remote-jobs/1", publication_date: daysAgoIso(2), tags: ["python", "django"], description: "1+ years of python" },
      { title: "Copywriter", company_name: "Nope", candidate_required_location: "Anywhere", url: "https://remotive.com/remote-jobs/2", publication_date: daysAgoIso(2), tags: [], description: "words words" },
    ],
  });
  check("remotive: python kept, non-python dropped", remotiveRoles.length === 1 && remotiveRoles[0].company === "Acme");

  const rokRoles = normalizeRemoteOk([
    { legal: "© RemoteOK" },
    { position: "Python Developer (Junior)", company: "Beta", slug: "beta-junior-py", url: "https://remoteok.com/remote-jobs/beta-junior-py", location: "Anywhere", date: daysAgoIso(3), tags: ["python"] },
    { position: "Senior Python Dev", company: "Delta", slug: "delta-senior-py", url: "https://remoteok.com/remote-jobs/delta-senior-py", location: "", date: daysAgoIso(3), tags: ["python"] },
  ]);
  check("remoteok: legal skipped, 2 jobs", rokRoles.length === 2);
  check("remoteok: empty location = worldwide", rokRoles[1].worldwide === true);

  const himRoles = normalizeHimalayas({
    jobs: [
      { guid: "https://himalayas.app/companies/acme/jobs/junior-python-developer", title: "Junior Python Developer", companyName: "Acme", locationRestrictions: [], seniority: ["Entry Level"], tags: ["python"], pubDate: Math.floor((Date.now() - 2 * DAY) / 1000), excerpt: "python 1 yr" },
      { guid: "https://himalayas.app/companies/zed/jobs/remote-python-dev", title: "Remote Python Developer", companyName: "Zed", locationRestrictions: [{ name: "United States" }], seniority: ["Mid"], tags: ["python"], pubDate: Math.floor((Date.now() - 2 * DAY) / 1000), excerpt: "5+ years of python" },
    ],
  });
  check("himalayas: 2 parsed", himRoles.length === 2);
  check("himalayas: empty restrictions worldwide", himRoles[0].worldwide === true && himRoles[1].worldwide === false);
  check("himalayas: seniority hint carried", himRoles[0].seniorityHint === "Entry Level");

  const jobRoles = normalizeJobicy({
    jobs: [
      { id: 77, jobTitle: "Junior Python Developer (Remote)", companyName: "Gamma", url: "https://jobicy.com/jobs/77", jobGeo: "Anywhere in the World", jobLevel: "junior", pubDate: daysAgoIso(1), tags: [{ slug: "python" }] },
    ],
  });
  check("jobicy: parsed with level+geo", jobRoles.length === 1 && jobRoles[0].seniorityHint === "junior" && jobRoles[0].worldwide);

  // ranking pipeline
  const cands: RawCandidate[] = [
    ...remotiveRoles,
    ...rokRoles.filter((r) => !/senior/i.test(r.title)),
    ...himRoles,
    ...jobRoles,
    ...wwrRoles,
    ...pyRoles,
    // a duplicate of the Acme junior role (older) → must dedupe
    { ...remotiveRoles[0], id: "remotive:dupe", ageDays: 9, publishedAt: daysAgoIso(9) },
  ];
  const ranked = rankCandidates(cands, { limit: 5 });
  check("ranking caps at limit", ranked.roles.length === 5, `${ranked.roles.length} roles`);
  check("no senior titles in output", ranked.roles.every((r) => !isSeniorTitle(r.title)));
  check("worldwide roles sort first", ranked.roles[0].worldwide === true && ranked.roles.slice(0, 3).every((r) => r.worldwide));
  check("dedupe collapsed Acme duplicate", ranked.roles.filter((r) => r.company === "Acme").length === 1);
  check("every role has verified http(s) apply link", ranked.roles.every((r) => /^https:\/\//.test(r.url)));
  check("fresher flags populated", ranked.roles.every((r) => r.fresherFlags.length > 0));

  const oldOnly: RawCandidate[] = [
    { ...remotiveRoles[0], ageDays: 45, publishedAt: daysAgoIso(45) },
  ];
  const widenedRes = rankCandidates(oldOnly, { limit: 5, maxAgeDays: 30, widenedAgeDays: 60 });
  check("widening kicks in when 30d window is empty", widenedRes.widened === true && widenedRes.roles.length === 1);

  // JSON extraction robustness
  check("extractJson: clean", extractJson('{"ranked":[],"summary":"x"}') !== null);
  check("extractJson: fenced", extractJson('```json\n{"ranked":[],"summary":"x"}\n```') !== null);
  check("extractJson: prose-wrapped", extractJson('Here you go:\n{"ranked":[],"summary":"x"} hope it helps') !== null);
  check("extractJson: trailing commas repaired", extractJson('{"ranked":[{"id":"a",},],"summary":"x",}') !== null);
  check("extractJson: garbage → null", extractJson("no json here at all") === null);

  // pipeline over mock fetch (route-level shape) + cache behavior
  const mockBoards = async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => {
      if (url.includes("remotive")) return JSON.stringify({ jobs: [] });
      if (url.includes("remoteok")) return "[]";
      if (url.includes("himalayas")) return JSON.stringify({ jobs: [] });
      if (url.includes("jobicy")) return JSON.stringify({ jobs: [] });
      if (url.includes("python.org")) return pyXml;
      return wwrXml; // wwr
    },
  });
  const t0 = await collectRemotePythonRoles({ limit: 10, refresh: true, fetcher: mockBoards as unknown as typeof fetch });
  const t1 = await collectRemotePythonRoles({ limit: 10, fetcher: mockBoards as unknown as typeof fetch });
  check("pipeline: miss then cache hit", t0.meta.cache === "miss" && t1.meta.cache === "hit");
  check("pipeline: sources all ok", t0.meta.sources.length === 6 && t0.meta.sources.every((s) => s.ok));
  check("pipeline: roles delivered", t0.roles.length >= 2);
  check("verified boards directory has 9 entries", VERIFIED_BOARDS.length === 9 && VERIFIED_BOARDS.every((b) => /^https:\/\//.test(b.url)));

  restoreKeys();
}

// ── PHASE 2: CHAIN ────────────────────────────────────────────
if (want("chain")) {
  console.log("\n── 2. CHAIN (mocked providers) ──");
  mockKeys();
  delete process.env.REMOTE_PYTHON_EXPLABS_MODELS;
  delete process.env.REMOTE_PYTHON_GROQ_MODELS;

  const chain = buildAiChain();
  check("chain: explabs is FIRST", chain[0]?.provider === "explabs");
  check("chain: gpt-oss-120b is the first model", chain[0]?.models[0] === "gpt-oss-120b");
  check("chain: explabs waterfall has 6 models", chain[0]?.models.length === 6);
  check("chain: groq is LAST", chain[chain.length - 1]?.provider === "groq");
  check("chain: groq first model gpt-oss-120b (groq catalog)", chain[chain.length - 1]?.models[0] === "openai/gpt-oss-120b");
  check("chain: openrouter + freechain + nvidia in between", ["openrouter", "freechain", "nvidia"].every((p) => chain.some((s) => s.provider === p)));

  const roles = rankCandidates(
    [
      { id: "remotive:1", title: "Junior Python Developer", company: "Acme", url: "https://remotive.com/remote-jobs/1", location: "Anywhere", worldwide: true, tags: ["python"], publishedAt: daysAgoIso(2), ageDays: 2, text: "junior python 1+ years", },
      { id: "pythonorg:2", title: "Python Developer at Beta", company: "Beta", url: "https://www.python.org/jobs/2/", location: "Anywhere", worldwide: true, tags: ["python"], publishedAt: daysAgoIso(3), ageDays: 3, text: "python role", },
    ],
    { limit: 2 }
  ).roles.map((r) => ({ ...r })) as unknown as import("../src/lib/jobs/remote-python").RemoteRole[];

  __resetRemotePythonAiCache();
  // 1) geo-wall rotation: gpt-oss 403/403 → minimax serves
  const calls: string[] = [];
  const mockGeo = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const key = `${new URL(url).host}:${body.model}`;
    calls.push(key);
    if (body.model === "gpt-oss-120b" || body.model === "gpt-oss-20b") {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: "This model is unavailable from the request's location, or we could not verify an eligible location. IP geolocation by DB-IP" } }),
      };
    }
    if (body.model === "minimax-m2.7-free") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ranked: [{ id: "remotive:1", fit: "high", score: 9, reason: "junior worldwide" }, { id: "pythonorg:2", fit: "medium", score: 6, reason: "no level stated" }], summary: "Fresher remote Python roles are competitive; junior-titled worldwide roles dominate." }) } }] }),
      };
    }
    return { ok: false, status: 500, text: async () => '{"error":{"message":"boom"}}' };
  }) as unknown as typeof fetch;

  const served = await rankRemoteRolesWithAI(roles, { fetcher: mockGeo });
  check("geo-wall: served by explabs/minimax after 2 rotations", served.provider === "explabs" && served.model === "minimax-m2.7-free" && !served.degraded);
  check("geo-wall: both gpt-oss attempts logged", served.notes.filter((n) => n.includes("gpt-oss") && n.includes("403")).length === 2);
  check("geo-wall: verdicts parsed", served.verdicts.length === 2 && served.verdicts[0].fit === "high");
  const merged = applyVerdicts(roles, served);
  check("applyVerdicts: high fit ordered first", merged[0].aiFit === "high" && merged[0].aiReason === "junior worldwide");

  // 2) minimal-body recovery: 400 invalid_parameter on max_tokens → retry without
  __resetRemotePythonAiCache();
  const bodies: Record<string, unknown>[] = [];
  let attempt = 0;
  process.env.REMOTE_PYTHON_EXPLABS_MODELS = "kimi-k2.6";
  const mockPin = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies.push(body);
    attempt++;
    if (attempt === 1) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Invalid parameter: 'max_tokens' is not supported for this model.", type: "invalid_request_error", code: "invalid_parameter", param: "max_tokens" } }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ranked":[{"id":"remotive:1","fit":"high","score":8,"reason":"ok"}],"summary":"s"}' } }] }),
    };
  }) as unknown as typeof fetch;
  const pinned = await rankRemoteRolesWithAI(roles, { fetcher: mockPin });
  check("minimal-body retry succeeded", pinned.provider === "explabs" && pinned.model === "kimi-k2.6" && !pinned.degraded);
  check("retry dropped max_tokens from body", "max_tokens" in bodies[0] && !("max_tokens" in bodies[1]));
  check("minimal-body note recorded", pinned.notes.some((n) => n.includes("minimal-body retry")));
  delete process.env.REMOTE_PYTHON_EXPLABS_MODELS;

  __resetRemotePythonAiCache();
  // 3) all providers fail → degraded, roles survive
  const mockDead = (async () => ({
    ok: false,
    status: 503,
    text: async () => '{"error":{"message":"service unavailable"}}',
  })) as unknown as typeof fetch;
  const dead = await rankRemoteRolesWithAI(roles, { fetcher: mockDead });
  check("all-dead: degraded mode", dead.degraded === true && dead.verdicts.length === 0);
  check("all-dead: trace notes collected", dead.notes.length > 0 && dead.notes[dead.notes.length - 1].includes("heuristic"));
  const deadMerged = applyVerdicts(roles, dead);
  check("all-dead: roles keep heuristic order", deadMerged.length === 2 && deadMerged.every((r) => r.aiFit === undefined));

  __resetRemotePythonAiCache();
  // 4) unparseable JSON on first model → rotates to next
  process.env.REMOTE_PYTHON_EXPLABS_MODELS = "gpt-oss-120b,glm-5.2";
  let glmTurn = false;
  const mockGarbage = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.model === "glm-5.2") {
      glmTurn = true;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'Sure! Here is my ranking: {"ranked":[{"id":"remotive:1","fit":"high","score":7,"reason":"junior"}],"summary":"tight market"}' } }] }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "I cannot answer that." } }] }) };
  }) as unknown as typeof fetch;
  const g = await rankRemoteRolesWithAI(roles, { fetcher: mockGarbage });
  check("garbage reply rotates to next model", glmTurn && g.model === "glm-5.2" && !g.degraded);
  delete process.env.REMOTE_PYTHON_EXPLABS_MODELS;

  restoreKeys();
}

// ── PHASE 3: ROUTE ────────────────────────────────────────────
if (want("route")) {
  console.log("\n── 3. ROUTE (GET /api/jobs/remote-python, mocked boards) ──");
  mockKeys();
  __resetRemotePythonCache();
  process.env.REMOTE_PYTHON_MAX_AGE_DAYS = "30";

  const pyXmlRoute = `<?xml version="1.0"?><rss><channel>
<item><title>Junior Python Developer at Acme Corp (Anywhere)</title><link>https://www.python.org/jobs/912/</link><pubDate>${new Date(Date.now() - DAY).toUTCString()}</pubDate><description><![CDATA[<p>entry level python</p>]]></description></item>
</channel></rss>`;
  const wwrXmlRoute = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[Python Developer (Anywhere in the World)]]></title><link>https://weworkremotely.com/remote-jobs/python-1</link><pubDate>${new Date(Date.now() - 2 * DAY).toUTCString()}</pubDate><description><![CDATA[<p>python 2 years</p>]]></description></item>
</channel></rss>`;

  __resetRemotePythonAiCache();
  const routeFetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.experientiallabs.ai")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ranked: [{ id: "pythonorg:912", fit: "high", score: 9, reason: "junior + worldwide" }], summary: "Remote Python fresher market is active this week." }) } }] }),
      };
    }
    if (u.includes("remotive")) return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
    if (u.includes("remoteok")) return { ok: true, status: 200, text: async () => "[]" };
    if (u.includes("himalayas")) return { ok: false, status: 500, text: async () => "oops" }; // one board down
    if (u.includes("jobicy")) return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [] }) };
    if (u.includes("python.org")) return { ok: true, status: 200, text: async () => pyXmlRoute };
    if (u.includes("weworkremotely")) return { ok: true, status: 200, text: async () => wwrXmlRoute };
    return { ok: false, status: 404, text: async () => "not found" };
  }) as unknown as typeof fetch;

  const origFetch = globalThis.fetch;
  globalThis.fetch = routeFetch;
  try {
    const { GET } = await import("../src/app/api/jobs/remote-python/route");
    const req = new Request("http://localhost:3000/api/jobs/remote-python?limit=5");
    const res = await GET(req as never);
    check("route: 200 OK", res.status === 200);
    const body = (await res.json()) as {
      ok: boolean;
      roles: { id: string; url: string; aiFit?: string }[];
      ai: { provider: string; model: string; degraded: boolean };
      meta: { sources: { id: string; ok: boolean; error?: string }[]; worldwideCount: number } | null;
    };
    check("route: ok=true", body.ok === true);
    check("route: roles delivered + capped", body.roles.length >= 1 && body.roles.length <= 5, `${body.roles.length} roles`);
    check("route: every role has a verified https apply link", body.roles.every((r) => /^https:\/\//.test(r.url)));
    check("route: AI served by explabs", body.ai.provider === "explabs" && body.ai.degraded === false);
    check("route: AI verdict applied to a role", body.roles.some((r) => r.aiFit !== undefined));
    check("route: dead board reported, others fine", (body.meta?.sources ?? []).some((s) => !s.ok && s.error === "HTTP 500") && (body.meta?.sources ?? []).filter((s) => s.ok).length === 5);

    // ai=0 → heuristic mode
    const req2 = new Request("http://localhost:3000/api/jobs/remote-python?limit=3&ai=0");
    const res2 = await GET(req2 as never);
    const body2 = (await res2.json()) as { ok: boolean; ai: { provider: string; degraded: boolean } };
    check("route: ?ai=0 → heuristic mode", res2.status === 200 && body2.ok === true && body2.ai.provider === "heuristic");

    // refresh=1 busts cache
    const req3 = new Request("http://localhost:3000/api/jobs/remote-python?limit=3&refresh=1");
    const res3 = await GET(req3 as never);
    const body3 = (await res3.json()) as { meta: { cache: string } | null };
    check("route: ?refresh=1 → cache miss", body3.meta?.cache === "miss");
  } finally {
    globalThis.fetch = origFetch;
    restoreKeys();
    __resetRemotePythonCache();
  }
}

// ── PHASE 4: LIVE ─────────────────────────────────────────────
if (want("live") && process.env.LIVE !== "0") {
  console.log("\n── 4. LIVE (real boards + real keys) ──");
  // re-read .env for the real keys (mock phases ran with dummies)
  try {
    const env = await fs.readFile(".env", "utf8");
    for (const line of env.split("\n")) {
      const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (m && /^(EXPLABS_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|NVIDIA_API_KEY)$/.test(m[1])) {
        process.env[m[1]] = m[2];
      }
    }
  } catch {
    /* no .env → keep whatever is set */
  }
  __resetRemotePythonCache();
  process.env.REMOTE_PYTHON_MAX_AGE_DAYS = "30";

  const t = Date.now();
  const live = await collectRemotePythonRoles({ limit: 10, refresh: true });
  const boardMs = Date.now() - t;
  const okSources = live.meta.sources.filter((s) => s.ok);
  console.log(`  boards: ${okSources.length}/${live.meta.sources.length} ok in ${boardMs}ms — ${okSources.map((s) => `${s.id}:${s.count}`).join(" ") || "none"}`);
  console.log(`  roles: ${live.roles.length} (worldwide ${live.meta.worldwideCount}, widened=${live.meta.widened})`);
  for (const r of live.roles.slice(0, 10)) {
    console.log(`    • ${r.title.slice(0, 58).padEnd(58)} ${r.worldwide ? "🌍" : "📍"} ${r.boardLabel.padEnd(15)} ${r.ageDays}d`);
  }
  check("live: at least 6 boards reachable", okSources.length >= 6, `${okSources.length}/6`);
  check("live: roles returned", live.roles.length >= 1, `${live.roles.length}`);
  check("live: roles are python + fresher-gated", live.roles.every((r) => !isSeniorTitle(r.title)));

  const aiT = Date.now();
  const liveAi = await rankRemoteRolesWithAI(live.roles, {});
  const aiMs = Date.now() - aiT;
  console.log(`  ai: ${liveAi.degraded ? "DEGRADED (heuristic)" : `${liveAi.provider}/${liveAi.model}`} in ${aiMs}ms — ${liveAi.verdicts.length} verdicts`);
  if (liveAi.summary) console.log(`  summary: ${liveAi.summary}`);
  for (const n of liveAi.notes.slice(-6)) console.log(`    ↳ ${n}`);
  check("live: AI chain completed (served or cleanly degraded)", liveAi.degraded === false || liveAi.notes.length > 0);
  const groqNote = liveAi.notes.find((n) => n.startsWith("groq/"));
  console.log(
    groqNote
      ? `  note: Groq (last-choice) reached from sandbox: ${groqNote} — expected here; from a residential IP it serves.`
      : "  note: chain never needed to reach Groq (an earlier provider served)."
  );
  if (!liveAi.degraded) check("live: AI verdicts cover roles", liveAi.verdicts.length > 0);
} else if (want("live")) {
  console.log("\n── 4. LIVE skipped (LIVE=0) ──");
}

console.log("\n" + "═".repeat(64));
if (failures.length === 0) {
  console.log("ALL v4.5 CHECKS PASSED ✅");
} else {
  console.log(`FAILED: ${failures.length}`);
  for (const f of failures) console.log(`  ❌ ${f}`);
  process.exitCode = 1;
}
