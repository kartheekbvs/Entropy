"use client";

import { formatDistanceToNow, differenceInDays, parseISO } from "date-fns";

export interface Application {
  id: string;
  company: string;
  role: string;
  source: string;
  jobUrl: string | null;
  location: string | null;
  salary: string | null;
  status: string;
  notes: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  name: string;
  company: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  notes: string | null;
  lastContactAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const PIPELINE = [
  "saved",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export type PipelineStatus = (typeof PIPELINE)[number];

export const STATUS_CONFIG: Record<
  string,
  { label: string; chip: string; dot: string }
> = {
  saved: {
    label: "Saved",
    chip: "bg-slate-500/15 text-slate-300 border-slate-500/30",
    dot: "bg-slate-400",
  },
  applied: {
    label: "Applied",
    chip: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    dot: "bg-sky-400",
  },
  assessment: {
    label: "Assessment",
    chip: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    dot: "bg-violet-400",
  },
  interview: {
    label: "Interview",
    chip: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    dot: "bg-amber-400",
  },
  offer: {
    label: "Offer",
    chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    dot: "bg-emerald-400",
  },
  rejected: {
    label: "Rejected",
    chip: "bg-red-500/15 text-red-300 border-red-500/30",
    dot: "bg-red-400",
  },
  withdrawn: {
    label: "Withdrawn",
    chip: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    dot: "bg-zinc-500",
  },
};

export const SOURCE_LABELS: Record<string, string> = {
  greenhouse: "Greenhouse (live)",
  lever: "Lever (live)",
  remotive: "Remotive (live)",
  jobicy: "Jobicy (live)",
  naukri: "Naukri",
  linkedin: "LinkedIn",
  internshala: "Internshala",
  foundit: "Foundit",
  google: "Google",
  referral: "Referral",
  other: "Other",
};

export const ACTIVE_STATUSES = ["applied", "assessment", "interview"];

export function daysSince(iso: string): number {
  return differenceInDays(new Date(), parseISO(iso));
}

export function timeAgo(iso: string): string {
  return formatDistanceToNow(parseISO(iso), { addSuffix: true });
}

export function daysAgoShort(iso: string): string {
  const d = daysSince(iso);
  if (d === 0) return "today";
  if (d === 1) return "1d ago";
  return `${d}d ago`;
}

export function computeStats(apps: Application[]) {
  const total = apps.length;
  const applied = apps.filter((a) => a.status !== "saved");
  const thisWeek = apps.filter(
    (a) => a.status !== "saved" && a.appliedAt && daysSince(a.appliedAt) <= 7
  );
  const active = apps.filter((a) => ACTIVE_STATUSES.includes(a.status));
  const interviews = apps.filter((a) => a.status === "interview");
  const offers = apps.filter((a) => a.status === "offer");
  const rejections = apps.filter((a) => a.status === "rejected");
  const movedForward = apps.filter((a) =>
    ["assessment", "interview", "offer"].includes(a.status)
  );
  const responseRate =
    applied.length === 0
      ? 0
      : Math.round(((movedForward.length + rejections.length) / applied.length) * 100);

  // Follow-ups: applied 7+ days ago with no movement
  const followUps = applied.filter(
    (a) =>
      a.status === "applied" &&
      ((a.appliedAt && daysSince(a.appliedAt) >= 7) ||
        (!a.appliedAt && daysSince(a.createdAt) >= 7))
  );

  // Streak: consecutive days (ending today or yesterday) with at least one application
  const appliedDays = new Set(
    applied
      .filter((a) => a.appliedAt || a.createdAt)
      .map((a) => parseISO(a.appliedAt ?? a.createdAt).toDateString())
  );
  let streak = 0;
  const cursor = new Date();
  if (!appliedDays.has(cursor.toDateString())) {
    cursor.setDate(cursor.getDate() - 1); // allow streak counted up to yesterday
  }
  while (appliedDays.has(cursor.toDateString())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const firstDate =
    applied.length > 0
      ? applied
          .map((a) => (a.appliedAt ?? a.createdAt))
          .sort()
          .find((d): d is string => Boolean(d))
      : null;

  return {
    total,
    appliedCount: applied.length,
    thisWeek: thisWeek.length,
    active,
    interviews: interviews.length,
    offers: offers.length,
    responseRate,
    followUps,
    streak,
    huntingDays: firstDate ? daysSince(firstDate) + 1 : 0,
  };
}
