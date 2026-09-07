// ─────────────────────────────────────────────────────────────
// Shared agent tool registry — the single source of truth.
// Used by BOTH the in-app Gemini agent loop (src/lib/agent/runner.ts)
// and the MCP server (mcp-server/index.ts), exactly like Claude
// Code's internal tool layer.
// ─────────────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { PROFILE, CANDIDATE_SKILL_NAMES, analyzeJd } from "@/lib/profile";
import { ROLE_PRESETS, CITY_PRESETS, buildBoardLinks } from "@/lib/job-links";
import { searchPublicJobs, SOURCE_COUNT } from "./jobs-api";
import { generateWithAuto } from "./llm";

export interface JsonSchemaParam {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  items?: JsonSchemaItems; // required by Gemini when type is "array"
  /** v3.5: nested object properties (external MCP tool schemas pass
   *  through here — e.g. github-mcp-server repo/issue arguments). */
  properties?: Record<string, JsonSchemaParam>;
  required?: string[];
}

/** Array item schema — flat (string) or structured (object), e.g. todo lists. */
export interface JsonSchemaItems {
  type: "string" | "number" | "boolean" | "object";
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchemaParam>;
  required?: string[];
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, JsonSchemaParam>;
  required?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: ToolParameters;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// ── Helpers ──────────────────────────────────────────────────
const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v.trim() : fallback;
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const VALID_STATUSES = ["saved", "applied", "assessment", "interview", "offer", "rejected", "withdrawn"];
const VALID_SOURCES = ["greenhouse", "lever", "remotive", "jobicy", "naukri", "linkedin", "internshala", "foundit", "google", "referral", "other"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Tool implementations ─────────────────────────────────────

const getProfile: ToolDef = {
  name: "get_profile",
  description:
    "Get the candidate's full profile: education, experience, projects, certifications, and claimed skills. Read this first to ground every decision in his real background.",
  parameters: { type: "object", properties: {} },
  execute: async () => ({
    name: PROFILE.name,
    title: PROFILE.title,
    education: `${PROFILE.education.degree}, ${PROFILE.education.school} (CGPA ${PROFILE.education.cgpa}, ${PROFILE.education.period})`,
    baseLocation: PROFILE.baseLocation,
    experience: PROFILE.experience.map((e) => `${e.role} @ ${e.company} (${e.period}, ${e.location})`),
    projects: PROFILE.projects.map((p) => `${p.name} [${p.stack}] — ${p.highlight}`),
    certifications: PROFILE.certifications,
    skills: CANDIDATE_SKILL_NAMES,
    targets: {
      roles: ["ML/AI + Data", "Python Developer"],
      levels: ["Internship", "Entry level"],
      locations: ["Hyderabad", "Bengaluru", "Chandigarh/Mohali", "Visakhapatnam", "Remote"],
    },
    today: today(),
  }),
};

const ROLE_ALIASES: Record<string, "ml" | "data" | "python" | "any"> = {
  ml: "ml",
  ai: "ml",
  data: "data",
  ds: "data",
  da: "data",
  python: "python",
  py: "python",
  any: "any",
};

const searchPublicJobsTool: ToolDef = {
  name: "search_public_jobs",
  description: `Search ${SOURCE_COUNT} LIVE public job sources in real time (Greenhouse ATS boards like Postman/Databricks/Stripe/Anthropic, Lever boards like Cred/Meesho, plus Remotive and Jobicy remote feeds). Returns normalized jobs pre-scored against the candidate's profile (0-100 match). This is real live data — no mock results.`,
  parameters: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["ml", "data", "python", "any"],
        description: "Role track to filter titles by",
      },
      location: {
        type: "string",
        enum: ["india", "remote", "any"],
        description: "'india' = India cities only; 'remote' = open-to-anywhere remote roles; 'any' = no location filter",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "Extra keywords that must appear in title/company/snippet (e.g. ['intern','fresher'])",
      },
      limit: { type: "number", description: "Max jobs to return (1-40, default 15)" },
    },
  },
  execute: async (args) => {
    const keywords = Array.isArray(args.keywords)
      ? args.keywords.map((k) => String(k)).slice(0, 6)
      : [];
    const roleKey = str(args.role, "any").toLowerCase();
    const role = ROLE_ALIASES[roleKey];
    if (!role) {
      return {
        error: `invalid role "${roleKey}" — use one of: ml, data, python, any`,
      };
    }
    const location = str(args.location, "any").toLowerCase();
    if (!["india", "remote", "any"].includes(location)) {
      return { error: `invalid location "${location}" — use india, remote, or any` };
    }
    return searchPublicJobs({
      role,
      location: location as "india" | "remote" | "any",
      keywords,
      limit: num(args.limit, 15),
    });
  },
};

const analyzeJdTool: ToolDef = {
  name: "analyze_jd",
  description:
    "Deterministically score a job description against the candidate's skill taxonomy (0-100, weighted, experience-aware). Returns matched skills, missing skills, and verdict. Instant and offline.",
  parameters: {
    type: "object",
    properties: {
      jd_text: { type: "string", description: "The full job description text" },
      job_title: { type: "string", description: "Optional job title for context" },
    },
    required: ["jd_text"],
  },
  execute: async (args) => {
    const jdText = str(args.jd_text);
    if (jdText.length < 40) return { error: "jd_text too short to analyze (need >= 40 chars)" };
    const r = analyzeJd(jdText);
    return {
      jobTitle: str(args.job_title) || undefined,
      score: r.score,
      verdict: r.verdict,
      verdictLabel: r.verdictLabel,
      matched: r.matched.map((m) => m.name),
      missing: r.missing.map((m) => m.name),
      experienceRequired: r.experienceRequired,
    };
  },
};

const addApplication: ToolDef = {
  name: "add_application",
  description:
    "Add a job to the tracker (deduplicates: if company+role already exists it updates notes/url instead of duplicating). Use for jobs worth tracking, with match reasoning in notes.",
  parameters: {
    type: "object",
    properties: {
      company: { type: "string", description: "Company name" },
      role: { type: "string", description: "Job title" },
      location: { type: "string", description: "Job location" },
      source: {
        type: "string",
        enum: VALID_SOURCES,
        description: "Where the job was found",
      },
      job_url: { type: "string", description: "Direct application URL" },
      salary: { type: "string", description: "Salary/stipend if known" },
      notes: { type: "string", description: "Match score, why it fits, priority" },
    },
    required: ["company", "role"],
  },
  execute: async (args) => {
    const company = str(args.company);
    const role = str(args.role);
    if (!company || !role) return { error: "company and role are required" };
    const source = VALID_SOURCES.includes(str(args.source)) ? str(args.source) : "other";
    const notes = str(args.notes).slice(0, 2000) || null;
    const jobUrl = str(args.job_url) || null;

    const existing = await db.application.findFirst({
      where: { company: { equals: company }, role: { equals: role } },
    });
    if (existing) {
      const updated = await db.application.update({
        where: { id: existing.id },
        data: {
          jobUrl: jobUrl ?? existing.jobUrl,
          notes: notes ?? existing.notes,
          location: str(args.location) || existing.location,
        },
      });
      return { created: false, id: updated.id, note: "already tracked — updated details" };
    }
    const created = await db.application.create({
      data: {
        company,
        role,
        location: str(args.location) || null,
        source,
        jobUrl,
        salary: str(args.salary) || null,
        notes,
        status: "saved",
      },
    });
    return { created: true, id: created.id, status: "saved" };
  },
};

const listApplications: ToolDef = {
  name: "list_applications",
  description: "List tracked applications with pipeline status. Filter by status or search text.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: VALID_STATUSES, description: "Filter by pipeline stage" },
      query: { type: "string", description: "Case-insensitive search in company/role/notes" },
    },
  },
  execute: async (args) => {
    const status = VALID_STATUSES.includes(str(args.status)) ? str(args.status) : undefined;
    const query = str(args.query) || undefined;
    const apps = await db.application.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(query
          ? {
              OR: [
                { company: { contains: query } },
                { role: { contains: query } },
                { notes: { contains: query } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: 40,
    });
    return {
      count: apps.length,
      applications: apps.map((a) => ({
        id: a.id,
        company: a.company,
        role: a.role,
        status: a.status,
        location: a.location,
        jobUrl: a.jobUrl,
        appliedAt: a.appliedAt?.toISOString().slice(0, 10) ?? null,
        updatedAt: a.updatedAt.toISOString().slice(0, 10),
        notes: a.notes?.slice(0, 200) ?? null,
      })),
    };
  },
};

const updateApplication: ToolDef = {
  name: "update_application",
  description:
    "Update a tracked application's pipeline status (saved→applied→assessment→interview→offer, or rejected/withdrawn) and/or append notes.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Application id from list_applications" },
      status: { type: "string", enum: VALID_STATUSES, description: "New pipeline status" },
      notes: { type: "string", description: "New notes (replaces old — include old content if still relevant)" },
      set_applied: { type: "boolean", description: "Set true when status moves to applied (records appliedAt)" },
    },
    required: ["id"],
  },
  execute: async (args) => {
    const id = str(args.id);
    const status = VALID_STATUSES.includes(str(args.status)) ? str(args.status) : undefined;
    const app = await db.application.findUnique({ where: { id } });
    if (!app) return { error: "application not found — run list_applications for valid ids" };
    const updated = await db.application.update({
      where: { id },
      data: {
        ...(status ? { status } : {}),
        ...(args.notes !== undefined ? { notes: str(args.notes).slice(0, 2000) || null } : {}),
        ...(status === "applied" && !app.appliedAt ? { appliedAt: new Date() } : {}),
      },
    });
    return { id: updated.id, status: updated.status, notes: updated.notes?.slice(0, 200) ?? null };
  },
};

const addContact: ToolDef = {
  name: "add_contact",
  description:
    "Save a professional contact (HR, recruiter, engineer, manager) the candidate has legitimately interacted with — e.g. a recruiter who emailed him. Never invent or scrape contact details.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Contact name" },
      company: { type: "string", description: "Their company" },
      role: { type: "string", description: "Their role (HR/Recruiter/Engineer/Manager/Other)" },
      email: { type: "string", description: "Email if known" },
      phone: { type: "string", description: "Phone if known" },
      linkedin: { type: "string", description: "LinkedIn profile URL if known" },
      notes: { type: "string", description: "Context: where they connected, what was discussed" },
    },
    required: ["name"],
  },
  execute: async (args) => {
    const name = str(args.name);
    if (!name) return { error: "name is required" };
    const created = await db.contact.create({
      data: {
        name,
        company: str(args.company) || null,
        role: str(args.role) || null,
        email: str(args.email) || null,
        phone: str(args.phone) || null,
        linkedin: str(args.linkedin) || null,
        notes: str(args.notes).slice(0, 1000) || null,
        lastContactAt: new Date(),
      },
    });
    return { created: true, id: created.id };
  },
};

const listContacts: ToolDef = {
  name: "list_contacts",
  description: "List saved contacts (HR/recruiters/engineers) with last-contact dates.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Case-insensitive search" },
    },
  },
  execute: async (args) => {
    const query = str(args.query) || undefined;
    const contacts = await db.contact.findMany({
      where: query
        ? {
            OR: [
              { name: { contains: query } },
              { company: { contains: query } },
              { notes: { contains: query } },
            ],
          }
        : {},
      orderBy: { updatedAt: "desc" },
      take: 30,
    });
    return {
      count: contacts.length,
      contacts: contacts.map((c) => ({
        id: c.id,
        name: c.name,
        company: c.company,
        role: c.role,
        email: c.email,
        linkedin: c.linkedin,
        lastContactAt: c.lastContactAt?.toISOString().slice(0, 10) ?? null,
      })),
    };
  },
};

const aiWrite: ToolDef = {
  name: "ai_write",
  description:
    "Generate polished written output grounded in the candidate's real profile: cover letters, outreach messages, gap-analysis plans, or resume bullet rewrites. Provide the task and full context.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "What to write: 'cover_letter', 'outreach_message', 'gap_analysis', 'resume_bullets', or custom instruction",
      },
      context: { type: "string", description: "All relevant details: job title, company, JD excerpt, match score, tone requests" },
    },
    required: ["task", "context"],
  },
  execute: async (args) => {
    const task = str(args.task);
    const context = str(args.context);
    if (!task || !context) return { error: "task and context are required" };
    const system = `You are an expert career-writing assistant for ${PROFILE.name}, a final-year Computer Engineering student (2027 batch, CGPA 8.3) targeting ML/AI and Python internships/entry roles. Write in first person as the candidate. Be specific, reference his InternPro AI/ML internship (Python automation, 15+ teams, +20% efficiency) and spam-classifier project (scikit-learn, TF-IDF, 94% accuracy on 10k+ emails) when relevant. Output ONLY the requested text — no preamble, no markdown fences, no placeholders (use the real company name).`;
    const { response, provider } = await generateWithAuto(
      [
        { role: "user", text: `TASK: ${task}\n\nCONTEXT:\n${context.slice(0, 6000)}` },
      ],
      [],
      system
    );
    return { text: response.text ?? "", provider };
  },
};

const getStats: ToolDef = {
  name: "get_stats",
  description:
    "Dashboard statistics: pipeline counts by status, application streak, applications in last 7 days, and follow-ups due (applied > 7 days ago with no movement).",
  parameters: { type: "object", properties: {} },
  execute: async () => {
    const apps = await db.application.findMany({ orderBy: { updatedAt: "desc" } });
    const byStatus: Record<string, number> = {};
    for (const a of apps) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const now = Date.now();
    const last7 = apps.filter(
      (a) => a.appliedAt && now - a.appliedAt.getTime() < 7 * 86400_000
    ).length;
    const followUpsDue = apps.filter(
      (a) => a.status === "applied" && now - a.updatedAt.getTime() > 7 * 86400_000
    );
    // streak = consecutive days with at least one application applied
    const days = new Set(
      apps.filter((a) => a.appliedAt).map((a) => a.appliedAt!.toISOString().slice(0, 10))
    );
    let streak = 0;
    for (let i = 0; i < 90; i++) {
      const d = new Date(now - i * 86400_000).toISOString().slice(0, 10);
      if (days.has(d)) streak++;
      else if (i > 0) break;
    }
    return {
      total: apps.length,
      byStatus,
      appliedLast7Days: last7,
      streakDays: streak,
      followUpsDue: followUpsDue.slice(0, 10).map((a) => ({
        id: a.id,
        company: a.company,
        role: a.role,
        daysSilent: Math.floor((now - a.updatedAt.getTime()) / 86400_000),
      })),
      today: today(),
    };
  },
};

const getBoardLinks: ToolDef = {
  name: "get_board_links",
  description:
    "Build verified pre-filtered deep links into Naukri/LinkedIn/Internshala/Foundit/Google Jobs for a role+city (fresher-filtered, freshness-limited). Use these for boards the public APIs don't cover — always give the candidate these links to click, never fabricated URLs.",
  parameters: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["ml", "ds", "da", "py"],
        description: "ml=Machine Learning, ds=Data Science, da=Data Analyst, py=Python Developer",
      },
      city: {
        type: "string",
        enum: ["hyderabad", "bengaluru", "chandigarh", "vizag", "remote"],
        description: "Location preset",
      },
      job_age_days: { type: "number", description: "Freshness filter: 1, 3 or 7 days" },
    },
  },
  execute: async (args) => {
    const role = ROLE_PRESETS.find((r) => r.id === str(args.role, "ml")) ?? ROLE_PRESETS[0];
    const city = CITY_PRESETS.find((c) => c.id === str(args.city, "bengaluru")) ?? CITY_PRESETS[1];
    const age = [1, 3, 7].includes(num(args.job_age_days, 3)) ? num(args.job_age_days, 3) : 3;
    return {
      role: role.label,
      city: city.label,
      jobAgeDays: age,
      links: buildBoardLinks(role, city, age).map((l) => ({
        board: l.board,
        url: l.url,
        note: l.note,
      })),
    };
  },
};

// ── Registry ─────────────────────────────────────────────────
export const AGENT_TOOLS: ToolDef[] = [
  getProfile,
  searchPublicJobsTool,
  analyzeJdTool,
  addApplication,
  listApplications,
  updateApplication,
  addContact,
  listContacts,
  aiWrite,
  getStats,
  getBoardLinks,
];

export function getTool(name: string): ToolDef | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) return { error: `unknown tool: ${name}` };
  try {
    return await tool.execute(args ?? {});
  } catch (e) {
    return { error: `tool ${name} failed: ${(e as Error).message}` };
  }
}
