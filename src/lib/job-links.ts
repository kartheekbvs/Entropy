// ─────────────────────────────────────────────────────────────
// One-click deep links into job boards.
// All URL formats verified live on 2026-09-03:
//  - Naukri:   /{slug}-jobs?city={city}&experience=0&jobAge={n}   (verified: city + fresher + "last 1 day" filters apply)
//  - LinkedIn: /jobs/search/?keywords=&location=&f_TPR=r86400&f_E=1,2 (&f_WT=2 remote)
//  - Internshala: /internships/{slug}-internship[-in-{city}]/ + /jobs/{slug}-jobs[-in-{city}]/
//  - Foundit:  /srp/results?query=&locations=&experienceRanges=0~1
//  - Google:   /search?q=...jobs...&ibp=htl;jobs (aggregates all boards)
// ─────────────────────────────────────────────────────────────

export interface RolePreset {
  id: string;
  label: string;
  keyword: string; // plain keyword for LinkedIn/Foundit/Google
  slug: string; // Naukri / Internshala slug
  icon: string; // lucide icon key handled in UI
}

export const ROLE_PRESETS: RolePreset[] = [
  { id: "ml", label: "Machine Learning", keyword: "machine learning", slug: "machine-learning", icon: "brain" },
  { id: "ds", label: "Data Science", keyword: "data science", slug: "data-science", icon: "flask" },
  { id: "da", label: "Data Analyst", keyword: "data analyst", slug: "data-analyst", icon: "chart" },
  { id: "py", label: "Python Developer", keyword: "python developer", slug: "python-developer", icon: "code" },
];

export interface CityPreset {
  id: string;
  label: string;
  naukri: string;
  linkedin: string;
  internshala: string;
  foundit: string;
  google: string;
  remote?: boolean;
}

export const CITY_PRESETS: CityPreset[] = [
  {
    id: "hyderabad",
    label: "Hyderabad",
    naukri: "hyderabad",
    linkedin: "Hyderabad",
    internshala: "hyderabad",
    foundit: "Hyderabad",
    google: "Hyderabad",
  },
  {
    id: "bengaluru",
    label: "Bengaluru",
    naukri: "bangalore",
    linkedin: "Bengaluru",
    internshala: "bangalore",
    foundit: "Bangalore",
    google: "Bengaluru",
  },
  {
    id: "chandigarh",
    label: "Chandigarh / Mohali",
    naukri: "chandigarh",
    linkedin: "Chandigarh",
    internshala: "chandigarh",
    foundit: "Chandigarh",
    google: "Mohali",
  },
  {
    id: "vizag",
    label: "Visakhapatnam (AP)",
    naukri: "visakhapatnam",
    linkedin: "Visakhapatnam",
    internshala: "visakhapatnam",
    foundit: "Visakhapatnam",
    google: "Visakhapatnam",
  },
  {
    id: "remote",
    label: "Remote / WFH",
    naukri: "",
    linkedin: "India",
    internshala: "",
    foundit: "Remote",
    google: "Remote",
    remote: true,
  },
];

export interface BoardLink {
  board: "Naukri" | "LinkedIn" | "Internshala (Internships)" | "Internshala (Jobs)" | "Foundit" | "Google Jobs";
  url: string;
  note: string;
  accent: boolean; // highlight primary boards
}

export function buildBoardLinks(
  role: RolePreset,
  city: CityPreset,
  jobAgeDays: number
): BoardLink[] {
  const links: BoardLink[] = [];

  // Naukri — fresher + freshness filter (city skipped for remote: all-India remote postings)
  const naukriCity = city.remote ? "" : `&city=${city.naukri}`;
  links.push({
    board: "Naukri",
    url: `https://www.naukri.com/${role.slug}-jobs?experience=0${naukriCity}&jobAge=${jobAgeDays}`,
    note: city.remote
      ? `Fresher · posted ≤ ${jobAgeDays}d · all India (remote roles listed nationwide)`
      : `Fresher · ${city.label} · posted ≤ ${jobAgeDays}d`,
    accent: true,
  });

  // LinkedIn — internship + entry level, last 24h / chosen window, remote filter if WFH
  const tprSeconds = jobAgeDays * 86400;
  const liRemote = city.remote ? "&f_WT=2" : "";
  links.push({
    board: "LinkedIn",
    url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(
      role.keyword
    )}&location=${encodeURIComponent(city.linkedin)}&f_TPR=r${tprSeconds}&f_E=1%2C2${liRemote}`,
    note: city.remote
      ? `Internship + entry · remote only · last ${jobAgeDays}d`
      : `Internship + entry · ${city.label} · last ${jobAgeDays}d`,
    accent: true,
  });

  // Internshala — internships (specialty) with city or WFH slug
  const isPrefix = city.remote ? "work-from-home-" : "";
  const isCity = city.remote || !city.internshala ? "" : `-in-${city.internshala}`;
  links.push({
    board: "Internshala (Internships)",
    url: `https://internshala.com/internships/${isPrefix}${role.slug}-internship${isCity}/`,
    note: city.remote
      ? `WFH internships in ${role.label}`
      : `Internships in ${role.label}${city.internshala ? ` · ${city.label}` : ""}`,
    accent: false,
  });

  // Internshala — entry jobs
  const isJobCity = city.remote || !city.internshala ? "" : `-in-${city.internshala}`;
  links.push({
    board: "Internshala (Jobs)",
    url: `https://internshala.com/jobs/${role.slug}-jobs${isJobCity}/`,
    note: city.remote ? `${role.label} jobs · all locations` : `${role.label} jobs · ${city.label}`,
    accent: false,
  });

  // Foundit
  links.push({
    board: "Foundit",
    url: `https://www.foundit.in/srp/results?query=${encodeURIComponent(
      role.keyword
    )}&locations=${encodeURIComponent(city.foundit)}&experienceRanges=0~1`,
    note: `0–1 yr · ${city.remote ? "remote" : city.label}`,
    accent: false,
  });

  // Google Jobs aggregator
  const gq = city.remote
    ? `${role.keyword} remote internship entry level jobs india`
    : `${role.keyword} jobs in ${city.google}`;
  links.push({
    board: "Google Jobs",
    url: `https://www.google.com/search?q=${encodeURIComponent(gq)}&ibp=htl;jobs`,
    note: "Aggregates Naukri + LinkedIn + company sites",
    accent: false,
  });

  return links;
}
