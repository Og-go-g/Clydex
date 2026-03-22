import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthAddress } from "@/lib/auth/session";
import { getOrCreateUser } from "@/lib/db/helpers";

const MAX_MESSAGES = 500;
const MAX_CONTENT_LENGTH = 50_000;
const MAX_PARTS_SIZE = 100_000; // 100KB per message parts
const VALID_ROLES = new Set(["user", "assistant"]);

export async function GET(request: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  try {
    const user = await getOrCreateUser(address);
    const session = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: user.id },
    });
    if (!session) {
      return NextResponse.json({ messages: [] });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      take: MAX_MESSAGES,
      select: { id: true, role: true, content: true, parts: true, createdAt: true },
    });

    return NextResponse.json({ messages });
  } catch (error) {
    console.error("[api/history/messages] GET error:", error);
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
  const { sessionId, messages } = body;
  if (typeof sessionId !== "string" || !Array.isArray(messages)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  if (messages.length > MAX_MESSAGES) {
    return NextResponse.json({ error: "Too many messages" }, { status: 400 });
  }

  // Validate each message
  const validated = [];
  for (const m of messages) {
    if (typeof m.id !== "string" || !m.id || m.id.length > 50) continue;
    if (!VALID_ROLES.has(m.role)) continue;
    const content = typeof m.content === "string" ? m.content.slice(0, MAX_CONTENT_LENGTH) : "";
    const createdAt = m.createdAt ? new Date(m.createdAt) : new Date();
    if (isNaN(createdAt.getTime())) continue;

    // Validate parts: must be array of objects with type string, within size limit
    let safeParts = undefined as undefined | typeof m.parts;
    if (Array.isArray(m.parts)) {
      try {
        // Limit array length to prevent abuse
        const trimmedParts = m.parts.slice(0, 50);
        // Validate each item has a type string
        const validParts = trimmedParts.filter(
          (p: unknown) => typeof p === "object" && p !== null && typeof (p as Record<string, unknown>).type === "string"
        );
        // Strip dangerous URI schemes from src, href, url fields
        for (const part of validParts) {
          const obj = part as Record<string, unknown>;
          for (const field of ["src", "href", "url"]) {
            if (typeof obj[field] === "string") {
              const val = (obj[field] as string).trim().toLowerCase();
              if (val.startsWith("javascript:") || val.startsWith("data:")) {
                delete obj[field];
              }
            }
          }
        }
        const serialized = JSON.stringify(validParts);
        if (serialized.length <= MAX_PARTS_SIZE) {
          safeParts = validParts;
        }
      } catch {
        // Malformed parts — skip
      }
    }

    validated.push({
      id: m.id as string,
      role: m.role as string,
      content,
      parts: safeParts as undefined,
      sessionId,
      createdAt,
    });
  }

  // Reject if all messages were invalid (prevents accidental history wipe)
  if (validated.length === 0 && messages.length > 0) {
    return NextResponse.json({ error: "No valid messages in payload" }, { status: 400 });
  }

  try {
    const user = await getOrCreateUser(address);
    const session = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: user.id },
    });
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Optimistic concurrency: only sync if no other tab synced in the last 1s.
    // This prevents two tabs from overwriting each other's messages.
    const now = new Date();
    const lockResult = await prisma.chatSession.updateMany({
      where: {
        id: sessionId,
        userId: user.id,
        updatedAt: { lt: new Date(now.getTime() - 1000) },
      },
      data: { updatedAt: now },
    });

    if (lockResult.count === 0) {
      // Another tab synced very recently — skip to avoid data loss
      return NextResponse.json({ ok: true, skipped: true });
    }

    // Safe to proceed — delete old + write new in one transaction
    await prisma.$transaction([
      prisma.chatMessage.deleteMany({ where: { sessionId } }),
      prisma.chatMessage.createMany({ data: validated }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[api/history/messages] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
