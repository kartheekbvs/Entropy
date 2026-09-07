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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { company, role, source, jobUrl, location, salary, status, notes, appliedAt } = body ?? {};

    const existing = await db.application.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    if (status !== undefined && (typeof status !== "string" || !VALID_STATUSES.includes(status))) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    // When moving out of "saved" for the first time, stamp appliedAt
    const nextStatus = status ?? existing.status;
    const shouldStampApplied = nextStatus !== "saved" && !existing.appliedAt;

    const application = await db.application.update({
      where: { id },
      data: {
        company: typeof company === "string" && company.trim() ? company.trim().slice(0, 200) : undefined,
        role: typeof role === "string" && role.trim() ? role.trim().slice(0, 200) : undefined,
        source: typeof source === "string" ? source : undefined,
        jobUrl: jobUrl !== undefined ? (typeof jobUrl === "string" ? (jobUrl.trim() || null) : null) : undefined,
        location: location !== undefined ? (typeof location === "string" ? (location.trim() || null) : null) : undefined,
        salary: salary !== undefined ? (typeof salary === "string" ? (salary.trim() || null) : null) : undefined,
        status: nextStatus,
        notes: notes !== undefined ? (typeof notes === "string" ? (notes.trim() || null) : null) : undefined,
        appliedAt: shouldStampApplied ? new Date() : appliedAt ? new Date(appliedAt) : undefined,
      },
    });

    return NextResponse.json({ application });
  } catch (error) {
    console.error("PATCH /api/applications/[id] failed:", error);
    return NextResponse.json({ error: "Failed to update application" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.application.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }
    await db.application.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/applications/[id] failed:", error);
    return NextResponse.json({ error: "Failed to delete application" }, { status: 500 });
  }
}
