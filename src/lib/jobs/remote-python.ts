/**
 * Remote Python Fresher Radar — live board aggregation engine.
 *
 * Aggregates open-anywhere remote Python developer roles suitable for a
 * fresher (0–1 yrs) from SIX verified public job boards, filters them
 * with deterministic heuristics, deduplicates, ranks and caches.
 *
 * Boards (all fetched server-side, all zero-API-key, all verified live):
 *   1. Remotive    — /api/remote-jobs?search=python   (JSON)
 *   2. RemoteOK    — /api                            (JSON array)
 *   3. WeWorkRemotely — categories/remote-programming-jobs.rss (RSS)
 *   4. Himalayas   — /jobs/api?limit=100             (JSON)
 *   5. Jobicy      — /api/v2/remote-jobs?tag=python  (JSON)
 *   6. Python.org  — /jobs/feed/rss/                 (RSS)
 *
 * Everything here is PURE + injectable (fetcher passed in / globalThis.fetch
 * patchable) so the whole pipeline is unit-testable without network.
 */

export type BoardId = "remotive" | "remoteok" | "wwr" | "himalayas" | "jobicy" | "pythonorg";

export interface RemoteRole {
  /** stable id: `<board>:<slug>` */
  id: string;
  title: string;
  company: string;
  board: BoardId;
  boardLabel: string;
  /** verified apply link on the board's own domain */
  url: string;
  location: string;
  worldwide: boolean;
  tags: string[];
  /** ISO date */
  publishedAt: string;
  ageDays: number;
  /** true when the board is a curated feed with no pubDate (python.org) */
  ageUnknown?: boolean;
  /** heuristic 0–100 */
  fresherScore: number;
  fresherFlags: string[];
  salary?: string;
  /** filled by the AI ranker (optional) */
  aiFit?: "high" | "medium" | "low";
  aiScore?: number;
  aiReason?: string;
}

export interface VerifiedBoard {
  id: string;
  name: string;
  url: string;
  note: string;
  /** live-fetched server-side (vs. link-only board) */
  live: boolean;
}

export interface BoardSourceStatus {
  id: BoardId;
  label: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

export interface RemotePythonResult {
  roles: RemoteRole[];
  boards: VerifiedBoard[];
  meta: {
    fetchedAt: string;
    cache: "hit" | "miss";
    limit: number;
    maxAgeDays: number;
    /** true when the active window was widened to fill the list */
    widened: boolean;
    worldwideCount: number;
    sources: BoardSourceStatus[];
  };
}

// ── configuration (env-overridable) ───────────────────────────

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_WIDENED_AGE_DAYS = 60;
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export const config = () => ({
  maxAgeDays: num(process.env.REMOTE_PYTHON_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS),
  widenedAgeDays: num(process.env.REMOTE_PYTHON_WIDENED_AGE_DAYS, DEFAULT_WIDENED_AGE_DAYS),
  fetchTimeoutMs: num(process.env.REMOTE_PYTHON_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
  cacheTtlMs: num(process.env.REMOTE_PYTHON_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS),
});

const UA =
  "Mozilla/5.0 (compatible; JobCommandCenter/4.5; +https://github.com) remote-python-fresher-radar";

// ── heuristic patterns ────────────────────────────────────────

const SENIOR_RE =
  /\b(senior|snr|sr\.?|lead|principal|staff|architect|head|director|manager|mgr|vp\b|chief|c[tx]o|expert|advanced|iii|iv\b)\b/i;
const FRESHER_RE =
  /\b(junior|jnr|jr\.?|entry[-\s]?level|fresher|fresh\s?graduate|graduate|trainee|intern|internship|beginner|associate)\b/i;
const YEARS_RE = /(\d{1,2})\s*(?:\+|to\s*\d{1,2}|-\s*\d{1,2})?\s*(?:years?|yrs?)\b/i;
const WORLDWIDE_RE =
  /\b(anywhere|world\s*wide|worldwide|global|globe|telecommute|remote\s*\(worldwide\)|earth)\b/i;

export function isSeniorTitle(title: string): boolean {
  return SENIOR_RE.test(title);
}

export function hasFresherSignal(title: string, extra = ""): boolean {
  return FRESHER_RE.test(title) || FRESHER_RE.test(extra);
}

/** first "N+ years" requirement found in a text blob (0 = none) */
export function requiredYears(text: string): number {
  const m = YEARS_RE.exec(text);
  return m ? Number(m[1]) : 0;
}

export function isWorldwide(location: string, restrictions: string[] | null | undefined): boolean {
  if (restrictions !== null && restrictions !== undefined) return restrictions.length === 0;
  return WORLDWIDE_RE.test(location || "");
}

function isPythonRole(title: string, tags: string[], extra = ""): boolean {
  return (
    /python|django|flask|fastapi|pandas|pytorch/i.test(title) ||
    tags.some((t) => /^python$/i.test(t.trim())) ||
    /python/i.test(extra.slice(0, 400))
  );
}

// ── RSS parsing (no XML deps — regex, CDATA-safe) ─────────────

interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description: string;
  regionHint: string;
}

export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/item>/i)[0];
    const pick = (tag: string): string => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#8211;|&#8212;/g, "-")
        .trim();
    };
    const title = pick("title");
    const link = pick("link");
    if (!title || !link) continue;
    items.push({
      title,
      link,
      pubDate: pick("pubDate"),
      description: pick("description"),
      regionHint: pick("location") || pick("georss:point"),
    });
  }
  return items;
}

function stripHtml(html: string, max = 600): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function daysSince(dateIso: string | number): number {
  const t = typeof dateIso === "number" ? dateIso * 1000 : Date.parse(dateIso);
  if (!Number.isFinite(t)) return 999;
  return Math.max(0, (Date.now() - t) / 86_400_000);
}

function isoOf(dateIso: string | number): string {
  const t = typeof dateIso === "number" ? dateIso * 1000 : Date.parse(dateIso);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

// ── per-board normalizers (raw → RemoteRole candidates) ───────

export interface RawCandidate {
  id: string;
  title: string;
  company: string;
  url: string;
  location: string;
  worldwide: boolean;
  tags: string[];
  publishedAt: string;
  ageDays: number;
  /** python.org-style curated feeds carry no pubDate - age is unknown */
  ageUnknown?: boolean;
  text: string;
  salary?: string;
  seniorityHint?: string;
}

const ok = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null;
const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normalizeRemotive(json: unknown): RawCandidate[] {
  if (!ok(json) || !Array.isArray(json.jobs)) return [];
  const out: RawCandidate[] = [];
  for (const j of arr(json.jobs)) {
    if (!ok(j)) continue;
    const title = str(j.title);
    const tags = arr(j.tags).map(str);
    if (!isPythonRole(title, tags)) continue;
    const loc = str(j.candidate_required_location);
    out.push({
      id: `remotive:${str(j.id) || str(j.url).split("/").pop()}`,
      title,
      company: str(j.company_name),
      url: str(j.url),
      location: loc,
      worldwide: isWorldwide(loc, null),
      tags,
      publishedAt: str(j.publication_date),
      ageDays: daysSince(str(j.publication_date)),
      text: `${title} ${tags.join(" ")} ${stripHtml(str(j.description))}`,
      salary: str(j.salary) || undefined,
    });
  }
  return out;
}

export function normalizeRemoteOk(json: unknown): RawCandidate[] {
  if (!Array.isArray(json)) return [];
  const out: RawCandidate[] = [];
  for (const j of arr(json)) {
    if (!ok(j) || !str(j.position)) continue; // [0] is the legal notice
    const title = str(j.position);
    const tags = arr(j.tags).map(str);
    if (!isPythonRole(title, tags)) continue;
    const loc = str(j.location);
    out.push({
      id: `remoteok:${str(j.slug) || str(j.url).split("/").pop()}`,
      title,
      company: str(j.company),
      url: str(j.url),
      location: loc || "Remote",
      worldwide: isWorldwide(loc, null) || loc === "",
      tags,
      publishedAt: str(j.date),
      ageDays: daysSince(str(j.date)),
      text: `${title} ${tags.join(" ")} ${stripHtml(str(j.description))}`,
      salary:
        j.salary_min && j.salary_max
          ? `$${str(j.salary_min)}–$${str(j.salary_max)}`
          : undefined,
    });
  }
  return out;
}

export function normalizeWwrRss(xml: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const item of parseRssItems(xml)) {
    if (!/python/i.test(item.title)) continue;
    // WWR convention: "Toptal: Python Backend Engineer (Anywhere)"
    const corp = /^([A-Za-z0-9 .&'\-/]{2,40}):\s*(.+)$/.exec(item.title);
    const rawTitle = corp ? corp[2] : item.title;
    out.push({
      id: `wwr:${item.link.split("/").pop() || item.title}`,
      title: rawTitle.replace(/\s*\((.*?)\)\s*$/, "").trim() || rawTitle,
      company: corp ? corp[1].trim() : "",
      url: item.link,
      location: corp ? corp[1].trim() : "",
      worldwide: WORLDWIDE_RE.test(item.title),
      tags: ["python"],
      publishedAt: item.pubDate,
      ageDays: daysSince(item.pubDate),
      text: `${item.title} ${stripHtml(item.description)}`,
    });
  }
  return out;
}

export function normalizeHimalayas(json: unknown): RawCandidate[] {
  if (!ok(json) || !Array.isArray(json.jobs)) return [];
  const out: RawCandidate[] = [];
  for (const j of arr(json.jobs)) {
    if (!ok(j)) continue;
    const title = str(j.title);
    const tags = arr(j.tags).map(str);
    const categories = arr(j.categories).map((c) => (ok(c) ? str(c.name) : str(c)));
    if (!isPythonRole(title, tags, `${categories.join(" ")} ${str(j.excerpt)}`)) continue;
    const restrictions = arr(j.locationRestrictions).map((r) => (ok(r) ? str(r.name) : str(r)));
    const seniority = arr(j.seniority).map(str);
    out.push({
      id: `himalayas:${str(j.guid).split("/").pop() || str(j.guid)}`,
      title,
      company: str(j.companyName),
      url: str(j.guid) || str(j.applicationLink),
      location: restrictions.length ? restrictions.join(", ") : "Anywhere",
      worldwide: isWorldwide("", restrictions),
      tags: [...tags, ...categories],
      publishedAt: isoOf(Number(j.pubDate) || 0),
      ageDays: daysSince(Number(j.pubDate) || 0),
      text: `${title} ${tags.join(" ")} ${stripHtml(str(j.excerpt))}`,
      seniorityHint: seniority.join(","),
    });
  }
  return out;
}

export function normalizeJobicy(json: unknown): RawCandidate[] {
  if (!ok(json) || !Array.isArray(json.jobs)) return [];
  const out: RawCandidate[] = [];
  for (const j of arr(json.jobs)) {
    if (!ok(j)) continue;
    const title = str(j.jobTitle);
    const tags = arr(j.tags).map((t) => (ok(t) ? str(t.slug ?? t.name) : str(t)));
    if (!isPythonRole(title, tags)) continue;
    const geo = str(j.jobGeo);
    out.push({
      id: `jobicy:${str(j.id) || str(j.jobSlug) || str(j.url).split("/").filter(Boolean).pop()}`,
      title,
      company: str(j.companyName),
      url: str(j.url),
      location: geo || "Remote",
      worldwide: isWorldwide(geo, null),
      tags,
      // jobicy's date field is `pubDate` (jobPublished is legacy)
      publishedAt: str(j.pubDate) || str(j.jobPublished),
      ageDays: daysSince(str(j.pubDate) || str(j.jobPublished)),
      text: `${title} ${tags.join(" ")} ${stripHtml(str(j.jobExcerpt ?? j.description))}`,
      seniorityHint: str(j.jobLevel),
    });
  }
  return out;
}

function title_hint(item: { title: string }): string {
  // strip ", Company" so company names like "Remote Systems GmbH" don't
  // fake a remote signature
  return item.title.replace(/,\s*[^,()]{2,40}\s*$/, "");
}

export function normalizePythonOrgRss(xml: string): RawCandidate[] {
  const out: RawCandidate[] = [];
  const fetched = new Date().toISOString();
  for (const item of parseRssItems(xml)) {
    // python.org titles: "Python Developer, Company" (current format) or
    // "Python Developer at Company (Loc)" (legacy) - python is guaranteed.
    const at = /^(.*?)\s+at\s+(.*?)(?:\s*\((.*)\))?\s*$/.exec(item.title);
    const comma = /^(.+?),\s*([^,()]{2,40})\s*$/.exec(item.title);
    const m = at ?? comma;
    const rawTitle = (m?.[1] ?? item.title).trim();
    const company = (at ? at[2] : comma ? comma[2] : "").trim();
    let loc = (at?.[3] ?? "").trim();
    // the description opens with the location list as plain text
    // ("Remote (within 2 hours of London timezone), Remote\n<p>...")
    const descHead = item.description.split(/\n|<(?:p|div|br)\b/i)[0]?.trim() ?? "";
    if (!loc && descHead && !/^</.test(descHead)) loc = descHead.slice(0, 80);
    const salaryM = /(?:Salary|Remuneration):\s*([^\n<]{3,40})/i.exec(item.description);
    // python.org also lists ONSITE roles — keep only remote/anywhere ones
    const remoteSignature = `${title_hint(item)} ${loc} ${descHead}`;
    if (/onsite|on-site|hybrid/i.test(remoteSignature)) continue;
    if (!/remote|anywhere|worldwide|telecommute|global|work from home/i.test(remoteSignature)) continue;
    out.push({
      id: `pythonorg:${item.link.split("/").filter(Boolean).pop() || item.title}`,
      title: rawTitle.replace(/\s*\((.*?)\)\s*$/, "").trim() || rawTitle,
      company,
      url: item.link,
      location: loc || "Anywhere",
      worldwide:
        isWorldwide(loc, null) ||
        (/^remote\b/i.test(loc) && !/\(|US|USA|America|Europe|UK|London|Germany|India|Canada/i.test(loc)),
      tags: ["python"],
      // python.org RSS carries NO pubDate - the feed is human-curated and
      // only contains OPEN jobs (filled ones are removed). Presence = active.
      publishedAt: item.pubDate || fetched,
      ageDays: 0,
      ageUnknown: true,
      text: `${item.title} ${loc} ${stripHtml(item.description)}`,
      salary: salaryM?.[1]?.trim(),
    });
  }
  return out;
}

// ── fresher heuristics + ranking ──────────────────────────────

export function scoreCandidate(c: RawCandidate): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 20; // base: is a remote python role

  if (hasFresherSignal(c.title)) {
    score += 40;
    flags.push("fresher title");
  }
  if (/entry[-\s]?level/i.test(c.seniorityHint ?? "")) {
    score += 20;
    flags.push("entry-level (board)");
  }
  if (/junior/i.test(c.seniorityHint ?? "")) {
    score += 20;
    flags.push("junior level (board)");
  }
  if (isSeniorTitle(c.title)) {
    score -= 100;
    flags.push("senior title");
  }

  const yrs = requiredYears(c.text);
  if (yrs > 0) {
    if (yrs > 3) {
      score -= 60;
      flags.push(`${yrs}+ yrs asked`);
    } else if (yrs > 1) {
      score -= 10;
      flags.push(`${yrs}+ yrs asked`);
    } else {
      score += 10;
      flags.push(`${yrs}+ yrs only`);
    }
  } else {
    score += 8;
    flags.push("no yrs stated");
  }

  if (c.worldwide) {
    score += 25;
    flags.push("open anywhere");
  }
  if (/python/i.test(c.title)) score += 10;
  if (c.ageDays <= 7) score += 15;
  else if (c.ageDays <= 14) score += 8;

  return { score: Math.max(0, Math.min(100, score)), flags };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function dedupeRoles(cands: RawCandidate[]): RawCandidate[] {
  const seen = new Map<string, RawCandidate>();
  for (const c of cands) {
    const key = `${slugify(c.company)}|${slugify(c.title)}`;
    if (!key.replace(/\|/g, "")) continue;
    const prev = seen.get(key);
    if (!prev || c.ageDays < prev.ageDays) seen.set(key, c);
  }
  return [...seen.values()];
}

export interface RankOptions {
  limit?: number;
  maxAgeDays?: number;
  widenedAgeDays?: number;
}

/** filter → dedupe → rank → cap; fills with region-restricted roles when
 *  worldwide supply is short, and widens the age window last. */
export function rankCandidates(
  cands: RawCandidate[],
  opts: RankOptions = {}
): { roles: Omit<RemoteRole, "aiFit" | "aiScore" | "aiReason">[]; widened: boolean } {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 25));
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const widenedAgeDays = opts.widenedAgeDays ?? DEFAULT_WIDENED_AGE_DAYS;

  let widened = false;
  const activeGate = (c: RawCandidate, maxAge: number) =>
    !isSeniorTitle(c.title) &&
    c.ageDays <= maxAge &&
    c.url.startsWith("http") &&
    (requiredYears(c.text) <= 3 || hasFresherSignal(c.title, c.seniorityHint ?? ""));

  let pool = dedupeRoles(cands.filter((c) => activeGate(c, maxAgeDays)));
  const worldwide = pool.filter((c) => c.worldwide);

  if (worldwide.length < limit) {
    const widenedPool = dedupeRoles(cands.filter((c) => activeGate(c, widenedAgeDays)));
    if (widenedPool.filter((c) => c.worldwide).length > worldwide.length) {
      widened = true;
      pool = widenedPool;
    }
  }

  const withScore = pool.map((c) => {
    const { score, flags } = scoreCandidate(c);
    return { c, score, flags };
  });
  withScore.sort(
    (a, b) =>
      Number(b.c.worldwide) - Number(a.c.worldwide) ||
      b.score - a.score ||
      a.c.ageDays - b.c.ageDays
  );

  const roles = withScore.slice(0, limit).map(({ c, score, flags }) => ({
    id: c.id,
    title: c.title,
    company: c.company || "See board",
    board: c.id.split(":")[0] as BoardId,
    boardLabel: BOARD_LABELS[c.id.split(":")[0] as BoardId] ?? c.id.split(":")[0],
    url: c.url,
    location: c.location,
    worldwide: c.worldwide,
    tags: [...new Set(c.tags.filter(Boolean))].slice(0, 8),
    publishedAt: c.publishedAt,
    ageDays: Math.round(c.ageDays),
    ageUnknown: c.ageUnknown,
    fresherScore: score,
    fresherFlags: flags,
    salary: c.salary,
  }));
  return { roles, widened };
}

// ── board registry + fetching ─────────────────────────────────

export const BOARD_LABELS: Record<BoardId, string> = {
  remotive: "Remotive",
  remoteok: "RemoteOK",
  wwr: "We Work Remotely",
  himalayas: "Himalayas",
  jobicy: "Jobicy",
  pythonorg: "python.org",
};

/** curated, link-verified boards for remote Python roles */
export const VERIFIED_BOARDS: VerifiedBoard[] = [
  { id: "remotive", name: "Remotive — Python", url: "https://remotive.com/remote-python-jobs", note: "Dedicated Python category, daily remote listings", live: true },
  { id: "remoteok", name: "RemoteOK — Python", url: "https://remoteok.com/remote-python-jobs", note: "Tag page with fresh worldwide roles", live: true },
  { id: "wwr", name: "We Work Remotely — Programming", url: "https://weworkremotely.com/categories/remote-programming-jobs", note: "Oldest remote board, region noted in title", live: true },
  { id: "himalayas", name: "Himalayas", url: "https://himalayas.app/jobs", note: "Seniority + timezone metadata on every job", live: true },
  { id: "jobicy", name: "Jobicy", url: "https://jobicy.com/jobs", note: "Curated remote jobs with level filters", live: true },
  { id: "pythonorg", name: "python.org Jobs", url: "https://www.python.org/jobs/", note: "The official Python job board (Telecommute)", live: true },
  { id: "remotepython", name: "Remote Python", url: "https://www.remotepython.com/", note: "Python-only niche board", live: false },
  { id: "workingnomads", name: "Working Nomads", url: "https://www.workingnomads.com/jobs?search=python", note: "Curated remote list, python search", live: false },
  { id: "nodesk", name: "NoDesk", url: "https://nodesk.co/remote-jobs/python/", note: "Remote-only aggregator", live: false },
];

interface BoardFetchDef {
  id: BoardId;
  label: string;
  /** may contain a `{offset}` placeholder when `pages` is set */
  url: string;
  json: boolean;
  parse: (data: unknown | string) => RawCandidate[];
  /** extra offset pages to sweep (himalayas returns 20/page, ignores tag/search) */
  pages?: number[];
}

const BOARD_DEFS: BoardFetchDef[] = [
  { id: "remotive", label: "Remotive", url: "https://remotive.com/api/remote-jobs?category=software-dev&limit=100", json: true, parse: (d) => normalizeRemotive(d) },
  { id: "remoteok", label: "RemoteOK", url: "https://remoteok.com/api", json: true, parse: (d) => normalizeRemoteOk(d) },
  { id: "wwr", label: "We Work Remotely", url: "https://weworkremotely.com/categories/remote-programming-jobs.rss", json: false, parse: (d) => normalizeWwrRss(String(d)) },
  { id: "himalayas", label: "Himalayas", url: "https://himalayas.app/jobs/api?limit=20&offset={offset}", json: true, parse: (d) => normalizeHimalayas(d), pages: [0, 20, 40, 60, 80] },
  { id: "jobicy", label: "Jobicy", url: "https://jobicy.com/api/v2/remote-jobs?tag=python&count=60", json: true, parse: (d) => normalizeJobicy(d) },
  { id: "pythonorg", label: "python.org", url: "https://www.python.org/jobs/feed/rss/", json: false, parse: (d) => normalizePythonOrgRss(String(d)) },
];

async function fetchBoard(
  def: BoardFetchDef,
  timeoutMs: number,
  fetcher: typeof fetch
): Promise<{ status: BoardSourceStatus; candidates: RawCandidate[] }> {
  const started = Date.now();
  const offsets = def.pages ?? [0];
  const candidates: RawCandidate[] = [];
  let lastError = "";
  let anyOk = false;

  for (const offset of offsets) {
    const url = def.url.replace("{offset}", String(offset));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetcher(url, {
        headers: { "User-Agent": UA, Accept: def.json ? "application/json" : "application/rss+xml, text/xml, */*" },
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const text = await res.text();
      let data: unknown | string = text;
      if (def.json) {
        try {
          data = JSON.parse(text);
        } catch {
          lastError = "invalid JSON";
          continue;
        }
      }
      const parsed = def.parse(data);
      const seen = new Set(candidates.map((c) => c.id));
      for (const c of parsed) if (!seen.has(c.id)) candidates.push(c);
      anyOk = true;
    } catch (e) {
      lastError = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message.slice(0, 80)) : "network error";
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    status: {
      id: def.id,
      label: def.label,
      ok: anyOk,
      count: candidates.length,
      ms: Date.now() - started,
      ...(anyOk ? {} : { error: lastError || "all pages failed" }),
    },
    candidates,
  };
}

// ── cache + top-level pipeline ────────────────────────────────

interface CacheEntry {
  at: number;
  result: RemotePythonResult;
}

let cache: CacheEntry | null = null;
/** test hook */
export function __resetRemotePythonCache(): void {
  cache = null;
}

/** console `status` accessor — tiny summary of the current cache, no fetch */
export function cachedSnapshot(): { roles: number; source: string; at: string } | null {
  if (!cache) return null;
  return {
    roles: cache.result.roles.length,
    source: cache.result.meta.cache === "hit" ? "cache hit" : "live sweep",
    at: cache.result.meta.fetchedAt,
  };
}

export interface PipelineOptions {
  limit?: number;
  refresh?: boolean;
  fetcher?: typeof fetch;
}

/**
 * Aggregate all boards in parallel, filter for ACTIVE fresher-suitable
 * open-anywhere Python remote roles and return up to `limit` ranked roles.
 * NEVER throws — a board failing only narrows the pool.
 */
export async function collectRemotePythonRoles(
  opts: PipelineOptions = {}
): Promise<RemotePythonResult> {
  const cfg = config();
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 25));
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const refresh = opts.refresh ?? false;

  if (!refresh && cache && Date.now() - cache.at < cfg.cacheTtlMs) {
    return { ...cache.result, meta: { ...cache.result.meta, cache: "hit", limit } };
  }

  const settled = await Promise.allSettled(
    BOARD_DEFS.map((d) => fetchBoard(d, cfg.fetchTimeoutMs, fetcher))
  );
  const statuses: BoardSourceStatus[] = [];
  let candidates: RawCandidate[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") {
      statuses.push(s.value.status);
      candidates = candidates.concat(s.value.candidates);
    }
  }

  const { roles, widened } = rankCandidates(candidates, {
    limit,
    maxAgeDays: cfg.maxAgeDays,
    widenedAgeDays: cfg.widenedAgeDays,
  });

  const result: RemotePythonResult = {
    roles,
    boards: VERIFIED_BOARDS,
    meta: {
      fetchedAt: new Date().toISOString(),
      cache: "miss",
      limit,
      maxAgeDays: cfg.maxAgeDays,
      widened,
      worldwideCount: roles.filter((r) => r.worldwide).length,
      sources: statuses.sort((a, b) => b.count - a.count),
    },
  };
  cache = { at: Date.now(), result };
  return result;
}
