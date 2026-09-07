import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, company, role, email, phone, linkedin, notes, lastContactAt } = body ?? {};

    const existing = await db.contact.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const contact = await db.contact.update({
      where: { id },
      data: {
        name: typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : undefined,
        company: company !== undefined ? (typeof company === "string" ? (company.trim() || null) : null) : undefined,
        role: role !== undefined ? (typeof role === "string" ? (role.trim() || null) : null) : undefined,
        email: email !== undefined ? (typeof email === "string" ? (email.trim() || null) : null) : undefined,
        phone: phone !== undefined ? (typeof phone === "string" ? (phone.trim() || null) : null) : undefined,
        linkedin: linkedin !== undefined ? (typeof linkedin === "string" ? (linkedin.trim() || null) : null) : undefined,
        notes: notes !== undefined ? (typeof notes === "string" ? (notes.trim() || null) : null) : undefined,
        lastContactAt:
          lastContactAt !== undefined
            ? lastContactAt
              ? new Date(lastContactAt)
              : null
            : undefined,
      },
    });

    return NextResponse.json({ contact });
  } catch (error) {
    console.error("PATCH /api/contacts/[id] failed:", error);
    return NextResponse.json({ error: "Failed to update contact" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = await db.contact.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    await db.contact.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("DELETE /api/contacts/[id] failed:", error);
    return NextResponse.json({ error: "Failed to delete contact" }, { status: 500 });
  }
}
