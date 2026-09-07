import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const contacts = await db.contact.findMany({
      orderBy: [{ createdAt: "desc" }],
    });
    return NextResponse.json({ contacts });
  } catch (error) {
    console.error("GET /api/contacts failed:", error);
    return NextResponse.json({ error: "Failed to load contacts" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, company, role, email, phone, linkedin, notes, lastContactAt } = body ?? {};

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const contact = await db.contact.create({
      data: {
        name: name.trim().slice(0, 200),
        company: typeof company === "string" && company.trim() ? company.trim().slice(0, 200) : null,
        role: typeof role === "string" && role.trim() ? role.trim().slice(0, 100) : null,
        email: typeof email === "string" && email.trim() ? email.trim().slice(0, 200) : null,
        phone: typeof phone === "string" && phone.trim() ? phone.trim().slice(0, 40) : null,
        linkedin: typeof linkedin === "string" && linkedin.trim() ? linkedin.trim().slice(0, 300) : null,
        notes: typeof notes === "string" && notes.trim() ? notes.trim().slice(0, 5000) : null,
        lastContactAt: lastContactAt ? new Date(lastContactAt) : null,
      },
    });

    return NextResponse.json({ contact }, { status: 201 });
  } catch (error) {
    console.error("POST /api/contacts failed:", error);
    return NextResponse.json({ error: "Failed to create contact" }, { status: 500 });
  }
}
