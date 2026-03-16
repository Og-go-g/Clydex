import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { getAuthAddress } from "@/lib/auth/session";
import { getUser, getAccount, getMarketStats } from "@/lib/n1/client";
import { resolveMarket, validateLeverage, TIERS } from "@/lib/n1/constants";
import { storePreview, consumePreview } from "@/lib/n1/preview-store";

// ─── Idempotency Key Store ──────────────────────────────────────
// Prevents double-execution of orders from network retries.

const idempotencyStore = new Map<string, { result: unknown; createdAt: number }>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_IDEMPOTENCY_KEYS = 5000;

function checkIdempotency(key: string): unknown | null {
  const entry = idempotencyStore.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_MS) {
    idempotencyStore.delete(key);
    return null;
  }
  return entry.result;
}

function storeIdempotency(key: string, result: unknown): void {
  // Evict oldest if at capacity
  if (idempotencyStore.size >= MAX_IDEMPOTENCY_KEYS) {
    const oldest = idempotencyStore.keys().next().value;
    if (oldest) idempotencyStore.delete(oldest);
  }
  idempotencyStore.set(key, { result, createdAt: Date.now() });
}

// ─── Zod Schemas ────────────────────────────────────────────────

const PrepareOrderSchema = z.object({
  action: z.literal("prepare"),
  symbol: z.string().min(1).max(20),
  side: z.enum(["Long", "Short"]),
  size: z.number().positive().finite().optional(),
  dollarSize: z.number().positive().finite().optional(),
  leverage: z.number().min(1).finite().default(1),
  orderType: z.enum(["market", "limit"]).default("market"),
  limitPrice: z.number().positive().finite().optional(),
});

const ExecuteOrderSchema = z.object({
  action: z.literal("execute"),
  previewId: z.string().min(1).max(100),
});

const CancelOrderSchema = z.object({
  action: z.literal("cancel"),
  orderId: z.string().min(1).max(100),
});

const OrderRequestSchema = z.discriminatedUnion("action", [
  PrepareOrderSchema,
  ExecuteOrderSchema,
  CancelOrderSchema,
]);

// ─── POST /api/order — order management endpoint ────────────────

export async function POST(req: Request) {
  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Check idempotency key
  const idempotencyKey = req.headers.get("x-idempotency-key");
  if (idempotencyKey) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length > 100) {
      return NextResponse.json({ error: "Invalid idempotency key" }, { status: 400 });
    }
    const cached = checkIdempotency(`${address}:${idempotencyKey}`);
    if (cached) {
      return NextResponse.json(cached);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = OrderRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues.map(i => i.message) },
      { status: 400 }
    );
  }

  const data = parsed.data;

  try {
    // ─── Prepare Order ───────────────────────────────────
    if (data.action === "prepare") {
      const market = resolveMarket(data.symbol);
      if (!market) {
        return NextResponse.json({ error: `Unknown market: "${data.symbol}"` }, { status: 400 });
      }

      const leverageError = validateLeverage(market, data.leverage);
      if (leverageError) {
        return NextResponse.json({ error: leverageError }, { status: 400 });
      }

      if (data.orderType === "limit" && !data.limitPrice) {
        return NextResponse.json({ error: "Limit orders require a price" }, { status: 400 });
      }

      if (!data.size && !data.dollarSize) {
        return NextResponse.json({ error: "Either size or dollarSize is required" }, { status: 400 });
      }

      // Fetch current price
      const stats = await getMarketStats(market.id);
      const markPrice = stats.perpStats?.mark_price ?? stats.indexPrice ?? 0;
      if (!markPrice) {
        return NextResponse.json({ error: `No price data for ${market.symbol}` }, { status: 502 });
      }

      const entryPrice = data.orderType === "limit" && data.limitPrice ? data.limitPrice : markPrice;

      // Calculate size
      let orderSize = data.size;
      if (!orderSize && data.dollarSize) {
        orderSize = data.dollarSize / entryPrice;
      }
      if (!orderSize || orderSize <= 0) {
        return NextResponse.json({ error: "Invalid order size" }, { status: 400 });
      }

      // Calculate economics
      const notionalValue = orderSize * entryPrice;
      const marginRequired = notionalValue / data.leverage;
      const imf = market.initialMarginFraction;
      const mmf = imf / 2;
      const liqDistance = entryPrice * mmf / data.leverage;
      const liquidationPrice = data.side === "Long"
        ? entryPrice - liqDistance
        : entryPrice + liqDistance;
      const estimatedFee = notionalValue * 0.0005;
      const priceImpact = notionalValue > 100_000 ? 0.1 : notionalValue > 10_000 ? 0.05 : 0.02;

      // Warnings
      const warnings: string[] = [];
      if (data.leverage >= 10) warnings.push("High leverage — liquidation risk is significant.");
      if (market.tier >= 4) warnings.push(`Low-liquidity market (Tier ${market.tier}) — expect higher slippage.`);

      // Check margin
      const user = await getUser(address);
      if (user?.accountIds?.length) {
        const account = await getAccount(user.accountIds[0]);
        const available = account.margins?.omf ?? 0;
        if (marginRequired > available * 0.5) {
          warnings.push("This order uses over 50% of your available margin.");
        }
        if (marginRequired > available) {
          warnings.push(`Insufficient margin. Need $${marginRequired.toFixed(2)}, have $${available.toFixed(2)}.`);
        }
      }

      const previewId = storePreview({
        market: market.symbol,
        side: data.side,
        size: orderSize,
        leverage: data.leverage,
        estimatedEntryPrice: entryPrice,
        estimatedLiquidationPrice: Math.max(0, liquidationPrice),
        marginRequired,
        estimatedFee,
        priceImpact,
        warnings,
      }, address);

      const result = {
        previewId,
        market: market.symbol,
        side: data.side,
        size: orderSize,
        leverage: data.leverage,
        orderType: data.orderType,
        estimatedEntryPrice: entryPrice,
        estimatedLiquidationPrice: Math.max(0, liquidationPrice),
        marginRequired,
        estimatedFee,
        priceImpact,
        warnings,
        notionalValue,
        tier: market.tier,
        maxLeverage: TIERS[market.tier]?.maxLeverage ?? 1,
      };

      if (idempotencyKey) storeIdempotency(`${address}:${idempotencyKey}`, result);
      return NextResponse.json(result);
    }

    // ─── Execute Order ───────────────────────────────────
    if (data.action === "execute") {
      const preview = consumePreview(data.previewId, address);
      if (!preview) {
        return NextResponse.json(
          { error: "Preview not found, expired, or already used. Create a new order." },
          { status: 400 }
        );
      }

      // Return validated preview for client-side wallet execution
      const result = {
        action: "execute" as const,
        ...preview,
        status: "awaiting_signature" as const,
      };

      if (idempotencyKey) storeIdempotency(`${address}:${idempotencyKey}`, result);
      return NextResponse.json(result);
    }

    // ─── Cancel Order ────────────────────────────────────
    if (data.action === "cancel") {
      // Validate user has this order
      const user = await getUser(address);
      if (!user?.accountIds?.length) {
        return NextResponse.json({ error: "No account found" }, { status: 400 });
      }

      // Return the cancel action for client-side wallet execution
      const result = {
        action: "cancel" as const,
        orderId: data.orderId,
        accountId: user.accountIds[0],
        status: "awaiting_signature" as const,
      };

      if (idempotencyKey) storeIdempotency(`${address}:${idempotencyKey}`, result);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("[/api/order] error:", error);
    return NextResponse.json(
      { error: "Failed to process order" },
      { status: 500 }
    );
  }
}
