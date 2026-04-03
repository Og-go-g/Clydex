import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withRLS } from "@/lib/db/with-rls";
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
    const { session, messages } = await withRLS(user.id, async (tx) => {
      const s = await tx.chatSession.findFirst({
        where: { id: sessionId, userId: user.id },
      });
      if (!s) return { session: null, messages: [] };

      const msgs = await tx.chatMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: "asc" },
        take: MAX_MESSAGES,
        select: { id: true, role: true, content: true, parts: true, createdAt: true },
      });
      return { session: s, messages: msgs };
    });

    if (!session) return NextResponse.json({ messages: [] });
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
  const validated: { id: string; role: string; content: string; parts: undefined; sessionId: string; createdAt: Date }[] = [];
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
        // Sanitize all string values — strip HTML tags and dangerous URI schemes
        const DANGEROUS_URI = /^(javascript|data|vbscript):/i;
        for (const part of validParts) {
          const obj = part as Record<string, unknown>;
          for (const [key, val] of Object.entries(obj)) {
            if (typeof val !== "string") continue;
            // Strip dangerous URI schemes from any URL-like field
            if (["src", "href", "url", "action", "formaction"].includes(key)) {
              if (DANGEROUS_URI.test(val.trim())) { delete obj[key]; continue; }
            }
            // Strip HTML tags from all string values to prevent stored XSS
            let sanitized = (val as string).replace(/<\/?[a-z][^>]*>/gi, "");
            // Strip event handler patterns (onclick=, onerror=, etc.)
            if (/\bon\w+\s*=/i.test(sanitized)) {
              sanitized = sanitized.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");
            }
            obj[key] = sanitized;
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
    const result = await withRLS(user.id, async (tx) => {
      const s = await tx.chatSession.findFirst({
        where: { id: sessionId, userId: user.id },
      });
      if (!s) return { error: "not_found" as const };

      // Optimistic concurrency: only sync if no other tab synced in the last 1s.
      const now = new Date();
      const lockResult = await tx.chatSession.updateMany({
        where: {
          id: sessionId,
          userId: user.id,
          updatedAt: { lt: new Date(now.getTime() - 1000) },
        },
        data: { updatedAt: now },
      });

      if (lockResult.count === 0) {
        return { skipped: true as const };
      }

      // Safe to proceed — delete old + write new inside RLS transaction
      // Filter by session ownership as defense-in-depth (RLS also enforces)
      await tx.chatMessage.deleteMany({ where: { sessionId, session: { userId: user.id } } });
      await tx.chatMessage.createMany({ data: validated });
      return { ok: true as const };
    });

    if ("error" in result) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, skipped: "skipped" in result });
  } catch (error) {
    console.error("[api/history/messages] POST error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
