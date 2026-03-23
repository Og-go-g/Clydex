import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthAddress } from "@/lib/auth/session";
import { getOrCreateUser } from "@/lib/db/helpers";

/**
 * GET  /api/history/sessions — list all chat sessions for the authenticated user
 * POST /api/history/sessions — create or sync a session
 * DELETE /api/history/sessions?id=xxx — delete a session
 */

export async function GET() {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const user = await getOrCreateUser(address);
    const sessions = await prisma.chatSession.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      take: 100,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("[api/history/sessions] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id, title } = body;
  if (typeof id !== "string" || !id || id.length > 50) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  const safeTitle = typeof title === "string" ? title.slice(0, 200) : "New Chat";

  try {
    const user = await getOrCreateUser(address);

    // Atomic ownership check + upsert in a single transaction to prevent TOCTOU race
    const session = await prisma.$transaction(async (tx) => {
      const existing = await tx.chatSession.findUnique({ where: { id } });

      if (existing && existing.userId !== user.id) {
        throw new Error("FORBIDDEN");
      }

      return tx.chatSession.upsert({
        where: { id },
        create: { id, title: safeTitle, userId: user.id },
        update: { title: safeTitle, updatedAt: new Date() },
      });
    });

    return NextResponse.json({ session });
  } catch (error) {
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("[api/history/sessions] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id || id.length > 50) {
    return NextResponse.json({ error: "Missing or invalid session id" }, { status: 400 });
  }

  try {
    const user = await getOrCreateUser(address);
    // Prisma schema has onDelete: Cascade on ChatMessage → ChatSession,
    // so messages are automatically deleted when the session is removed.
    // Explicit message deletion here as defense-in-depth.
    await prisma.$transaction([
      prisma.chatMessage.deleteMany({ where: { sessionId: id, session: { userId: user.id } } }),
      prisma.chatSession.deleteMany({ where: { id, userId: user.id } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/history/sessions] error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
