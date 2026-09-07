import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const VALID_STATUSES = [
  "saved",
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
];

const VALID_SOURCES = [
  "naukri",
  "linkedin",
  "internshala",
  "foundit",
  "google",
  "referral",
  "other",
];

export async function GET() {
  try {
    const applications = await db.application.findMany({
      orderBy: [{ createdAt: "desc" }],
    });
    return NextResponse.json({ applications });
  } catch (error) {
    console.error("GET /api/applications failed:", error);
    return NextResponse.json({ error: "Failed to load applications" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company, role, source, jobUrl, location, salary, status, notes, appliedAt } = body ?? {};

    if (!company || typeof company !== "string" || !company.trim()) {
      return NextResponse.json({ error: "Company is required" }, { status: 400 });
    }
    if (!role || typeof role !== "string" || !role.trim()) {
      return NextResponse.json({ error: "Role is required" }, { status: 400 });
    }

    const finalStatus =
      typeof status === "string" && VALID_STATUSES.includes(status) ? status : "saved";
    const finalSource =
      typeof source === "string" && VALID_SOURCES.includes(source) ? source : "other";

    const application = await db.application.create({
      data: {
        company: company.trim().slice(0, 200),
        role: role.trim().slice(0, 200),
        source: finalSource,
        jobUrl: typeof jobUrl === "string" && jobUrl.trim() ? jobUrl.trim().slice(0, 1000) : null,
        location: typeof location === "string" && location.trim() ? location.trim().slice(0, 200) : null,
        salary: typeof salary === "string" && salary.trim() ? salary.trim().slice(0, 100) : null,
        status: finalStatus,
        notes: typeof notes === "string" && notes.trim() ? notes.trim().slice(0, 5000) : null,
        appliedAt: finalStatus !== "saved" ? (appliedAt ? new Date(appliedAt) : new Date()) : null,
      },
    });

    return NextResponse.json({ application }, { status: 201 });
  } catch (error) {
    console.error("POST /api/applications failed:", error);
    return NextResponse.json({ error: "Failed to create application" }, { status: 500 });
  }
}
