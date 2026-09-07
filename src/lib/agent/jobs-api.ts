// ─────────────────────────────────────────────────────────────
// Real-time public job ingestion — 21 verified live sources.
// Greenhouse + Lever are the OFFICIAL public ATS JSON APIs that
// companies publish for programmatic access; Remotive + Jobicy
// are public remote-job aggregator APIs. No login, no ToS risk.
// Verified live: 2026-09-03
// ─────────────────────────────────────────────────────────────

import { analyzeJd } from "@/lib/profile";

export type JobSource = "greenhouse" | "lever" | "remotive" | "jobicy";

export interface NormalizedJob {
  id: string;
  source: JobSource;
  sourceBoard: string;
  company: string;
  title: string;
  location: string;
  url: string;
  postedAt: string | null;
  remote: boolean;
  snippet: string;
  matchScore: number;
  verdict: "strong" | "moderate" | "stretch";
  seniority: "intern" | "entry" | "mid" | "senior" | "unknown";
  matchedSkills: string[];
  missingSkills: string[];
}

export interface JobsQuery {
  role: "ml" | "data" | "python" | "any";
  location: "india" | "remote" | "any";
  keywords?: string[];
  limit: number;
}

export interface JobsResult {
  generatedAt: string;
  query: { role: string; location: string; keywords: string[] };
  sources: { ok: string[]; failed: string[]; cached: string[] };
  totalFound: number;
  jobs: NormalizedJob[];
}

// ── Live source registry (each verified 2026-09-03) ──────────
const GREENHOUSE_BOARDS = [
  "postman", "databricks", "stripe", "cloudflare", "mongodb", "elastic",
  "coinbase", "twilio", "samsara", "figma", "airtable", "reddit",
  "discord", "roblox", "pinterest", "anthropic", "togetherai",
] as const;

const LEVER_BOARDS = ["cred", "meesho"] as const;

export const SOURCE_COUNT =
  GREENHOUSE_BOARDS.length + LEVER_BOARDS.length + 2; // + remotive + jobicy

// ── Role presets (title regex + extra scoring keywords) ──────
const ROLE_PRESETS: Record<
  JobsQuery["role"],
  { label: string; titleRegex: RegExp | null }
> = {
  ml: {
    label: "ML/AI + Data",
    titleRegex:
      /machine learning|\bml\b|\bai\b|artificial intelligen|deep learning|\bnlp\b|\bllm\b|data scien|computer vision|mlops|generative ai|\bgpt\b|research engineer|applied scientist/i,
  },
  data: {
    label: "Data & Analytics",
    titleRegex:
      /data|analyst|analytics|business intelligen|statistic|reporting|\bbi\b/i,
  },
  python: {
    label: "Python / Software Engineer",
    titleRegex:
      /python|backend|back-end|software engineer|software developer|\bsde\b|\bswe\b|full ?stack|api|platform engineer|systems engineer|cloud engineer|automation/i,
  },
  any: { label: "Any engineering role", titleRegex: null },
};

const INDIA_REGEX =
  /india|bangalor|bengaluru|hyderabad|chandigarh|mohali|mumbai|delhi|pune|chennai|gurgaon|gurugram|noida|kolkata|ahmedabad|secunderabad|vizag|visakhapatnam/i;
const REMOTE_REGEX = /remote|anywhere|worldwide|global|work from home|wfh/i;
// Geo-restricted remote (e.g. "Remote - US", "USA", "Europe") — not usable from India
const REMOTE_GEO_BLOCK =
  /(^|[^a-z])(us|usa|u\.s\.|united states|america|canada|uk|u\.k\.|united kingdom|europe|\beu\b|emea|germany|netherlands|latam)([^a-z]|$)/i;
const GEO_OPEN = /india|worldwide|global|anywhere|international|remote only/i;

// ── 30-minute in-memory cache (per source) ───────────────────
interface CacheEntry {
  ts: number;
  jobs: NormalizedJob[];
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

const FETCH_TIMEOUT_MS = 12_000;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json", "user-agent": "job-command-center/1.0 (+agent)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function seniorityFromTitle(title: string): NormalizedJob["seniority"] {
  const t = title.toLowerCase();
  if (/intern|trainee|apprentice|co-?op|student/.test(t)) return "intern";
  if (/fresher|entry[- ]level|graduate|junior|associate/.test(t)) return "entry";
  if (/senior|staff|principal|lead|manager|director|head|architect|\bvp\b|\bavp\b/.test(t)) return "senior";
  if (/\b(ii|2|iii|3)\b/.test(t)) return "mid";
  return "unknown";
}

function matchFor(
  job: Omit<NormalizedJob, "matchScore" | "verdict" | "matchedSkills" | "missingSkills" | "seniority">
): {
  matchScore: number;
  verdict: NormalizedJob["verdict"];
  matchedSkills: string[];
  missingSkills: string[];
} {
  const text = `${job.title} ${job.company} ${job.location} ${job.snippet}`;
  const analysis = analyzeJd(text.slice(0, 2500));
  let score = analysis.score;
  const seniority = seniorityFromTitle(job.title);
  // Gently penalize clearly senior roles; boost intern/entry roles
  if (seniority === "senior") score = Math.round(score * 0.75);
  if (seniority === "intern" || seniority === "entry") score = Math.min(100, score + 6);
  return {
    matchScore: Math.max(0, Math.min(100, score)),
    verdict: score >= 70 ? "strong" : score >= 45 ? "moderate" : "stretch",
    matchedSkills: analysis.matched.map((m) => m.name).slice(0, 8),
    missingSkills: analysis.missing.map((m) => m.name).slice(0, 6),
  };
}

// ── Source fetchers → normalized pools ───────────────────────

interface GhResponse {
  jobs: Array<{
    id: number;
    title: string;
    absolute_url: string;
    location?: { name?: string };
    updated_at?: string;
    first_published?: string;
    company_name?: string;
  }>;
}

async function fetchGreenhouse(board: string): Promise<NormalizedJob[]> {
  const data = await fetchJson<GhResponse>(
    `https://boards-api.greenhouse.io/v1/boards/${board}/jobs`
  );
  return (data.jobs ?? []).map((j) => {
    const location = j.location?.name ?? "Unspecified";
    const company = j.company_name || board.charAt(0).toUpperCase() + board.slice(1);
    const base = {
      id: `gh:${board}:${j.id}`,
      source: "greenhouse" as const,
      sourceBoard: board,
      company,
      title: j.title,
      location,
      url: j.absolute_url,
      postedAt: j.first_published ?? j.updated_at ?? null,
      remote: REMOTE_REGEX.test(location),
      snippet: "",
    };
    return { ...base, seniority: seniorityFromTitle(j.title), ...matchFor(base) };
  });
}

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  categories?: { location?: string; commitment?: string; department?: string; team?: string };
  descriptionPlain?: string;
}

async function fetchLever(board: string): Promise<NormalizedJob[]> {
  const data = await fetchJson<LeverPosting[]>(
    `https://api.lever.co/v0/postings/${board}?mode=json`
  );
  return (Array.isArray(data) ? data : []).map((j) => {
    const location =
      j.categories?.location ??
      (j.workplaceType === "remote" ? "Remote" : j.country ? `Country: ${j.country}` : "Unspecified");
    const company = board.charAt(0).toUpperCase() + board.slice(1);
    const base = {
      id: `lv:${board}:${j.id}`,
      source: "lever" as const,
      sourceBoard: board,
      company,
      title: j.text,
      location,
      url: j.hostedUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      remote: j.workplaceType === "remote" || REMOTE_REGEX.test(location),
      snippet: stripHtml(j.descriptionPlain ?? "").slice(0, 600),
    };
    return { ...base, seniority: seniorityFromTitle(j.text), ...matchFor(base) };
  });
}

interface RemotiveResponse {
  jobs: Array<{
    id: number | string;
    url: string;
    title: string;
    company_name: string;
    category?: string;
    job_type?: string;
    candidate_required_location?: string;
    publication_date?: string;
    description?: string;
  }>;
}

async function fetchRemotive(): Promise<NormalizedJob[]> {
  const data = await fetchJson<RemotiveResponse>(
    "https://remotive.com/api/remote-jobs?limit=100"
  );
  return (data.jobs ?? []).map((j) => {
    const location = j.candidate_required_location || "Remote (worldwide)";
    const base = {
      id: `rm:${j.id}`,
      source: "remotive" as const,
      sourceBoard: "remotive",
      company: j.company_name || "Unknown",
      title: j.title,
      location,
      url: j.url,
      postedAt: j.publication_date ?? null,
      remote: true,
      snippet: stripHtml(j.description ?? "").slice(0, 600),
    };
    return { ...base, seniority: seniorityFromTitle(j.title), ...matchFor(base) };
  });
}

interface JobicyResponse {
  jobs: Array<{
    id: number | string;
    url: string;
    jobName?: string;
    jobTitle?: string;
    company?: { name?: string };
    companyName?: string;
    jobGeo?: string;
    jobLevel?: string;
    jobType?: string | string[];
    jobDescription?: string;
    jobExcerpt?: string;
    pubDate?: string;
  }>;
}

async function fetchJobicy(tag?: string): Promise<NormalizedJob[]> {
  const params = new URLSearchParams({ count: "100" });
  if (tag) params.set("tag", tag);
  const data = await fetchJson<JobicyResponse>(
    `https://jobicy.com/api/v2/remote-jobs?${params.toString()}`
  );
  return (data.jobs ?? [])
    .map((j) => {
      // Tagged vs untagged responses use different field names
      const company = j.companyName ?? j.company?.name ?? "Unknown";
      const base = {
        id: `jb:${j.id}`,
        source: "jobicy" as const,
        sourceBoard: "jobicy",
        company,
        title: j.jobName ?? j.jobTitle ?? "",
        location: j.jobGeo || "Remote",
        url: j.url,
        postedAt: j.pubDate ?? null,
        remote: true,
        snippet: stripHtml(j.jobDescription ?? j.jobExcerpt ?? "").slice(0, 600),
      };
      return { ...base, seniority: seniorityFromTitle(base.title), ...matchFor(base) };
    })
    .filter((j) => j.title && j.url);
}

// ── Cached source loader ─────────────────────────────────────
interface SourceLoader {
  key: string;
  load: () => Promise<NormalizedJob[]>;
}

function allSourceLoaders(role: JobsQuery["role"]): SourceLoader[] {
  const loaders: SourceLoader[] = [];
  for (const board of GREENHOUSE_BOARDS) {
    loaders.push({
      key: `gh:${board}`,
      load: () => fetchGreenhouse(board),
    });
  }
  for (const board of LEVER_BOARDS) {
    loaders.push({ key: `lv:${board}`, load: () => fetchLever(board) });
  }
  loaders.push({ key: "remotive", load: () => fetchRemotive() });
  // Jobicy tag narrows by role keywords for better recall
  const jobicyTag =
    role === "ml" ? "machine learning" : role === "python" ? "python" : role === "data" ? "data" : undefined;
  loaders.push({ key: `jobicy:${jobicyTag ?? "all"}`, load: () => fetchJobicy(jobicyTag) });
  return loaders;
}

async function loadPool(loader: SourceLoader): Promise<{ jobs: NormalizedJob[]; cached: boolean }> {
  const hit = CACHE.get(loader.key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { jobs: hit.jobs, cached: true };
  const jobs = await loader.load();
  CACHE.set(loader.key, { ts: Date.now(), jobs });
  return { jobs, cached: false };
}

// ── Public search API (used by the agent tool + MCP tool) ────
export async function searchPublicJobs(query: JobsQuery): Promise<JobsResult> {
  const preset = ROLE_PRESETS[query.role] ?? ROLE_PRESETS.any;
  const keywords = (query.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const limit = Math.max(1, Math.min(40, query.limit || 15));
  const loaders = allSourceLoaders(query.role);

  const ok: string[] = [];
  const failed: string[] = [];
  const cached: string[] = [];
  let pool: NormalizedJob[] = [];

  // Chunked concurrency (6 at a time) — polite to the APIs
  const CHUNK = 6;
  for (let i = 0; i < loaders.length; i += CHUNK) {
    const chunk = loaders.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map(async (l) => ({ key: l.key, ...(await loadPool(l)) }))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        ok.push(r.value.key);
        if (r.value.cached) cached.push(r.value.key);
        pool = pool.concat(r.value.jobs);
      } else {
        failed.push(
          String((r.reason as Error)?.message ?? r.reason ?? "unknown").slice(0, 100)
        );
      }
    }
  }

  // Freshness window — boards are live listings; keep last 45 days
  const FRESH_MS = 45 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  // Dedupe across sources by company+title
  const seen = new Set<string>();
  const filtered = pool.filter((j) => {
    const dedupeKey = `${j.company}|${j.title}`.toLowerCase();
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    if (preset.titleRegex && !preset.titleRegex.test(j.title)) return false;
    if (query.location === "india" && !INDIA_REGEX.test(j.location)) return false;
    if (query.location === "remote") {
      const geoRestricted =
        REMOTE_GEO_BLOCK.test(j.location) && !GEO_OPEN.test(j.location);
      if (geoRestricted || (!j.remote && !REMOTE_REGEX.test(j.location))) return false;
    }
    if (j.postedAt) {
      const t = Date.parse(j.postedAt);
      if (!Number.isNaN(t) && now - t > FRESH_MS) return false;
    }
    if (keywords.length > 0) {
      const hay = `${j.title} ${j.company} ${j.location} ${j.snippet}`.toLowerCase();
      if (!keywords.some((k) => hay.includes(k))) return false;
    }
    return true;
  });

  filtered.sort(
    (a, b) =>
      b.matchScore - a.matchScore ||
      (b.postedAt ?? "").localeCompare(a.postedAt ?? "")
  );

  return {
    generatedAt: new Date().toISOString(),
    query: { role: preset.label, location: query.location, keywords },
    sources: { ok, failed, cached },
    totalFound: filtered.length,
    jobs: filtered.slice(0, limit),
  };
}
