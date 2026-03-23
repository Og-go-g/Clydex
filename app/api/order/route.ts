import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod/v4";
import { getAuthAddress } from "@/lib/auth/session";
import { getUser, getAccount, getMarketStats } from "@/lib/n1/client";
import { resolveMarket, validateLeverage, ensureMarketCache, TIERS } from "@/lib/n1/constants";
import { storePreview, consumePreview } from "@/lib/n1/preview-store";
import { orderLimiter, memRateLimit, memCleanup } from "@/lib/ratelimit";

// ─── Idempotency Key Store ──────────────────────────────────────
// Prevents double-execution of orders from network retries.

// ─── Idempotency Store (Redis in prod, in-memory fallback) ───────
const IDEMPOTENCY_TTL_S = 300; // 5 minutes
const IDEMPOTENCY_PREFIX = "idem:";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let idempRedis: any = null;
async function getIdempRedis() {
  if (idempRedis) return idempRedis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const { Redis } = await import("@upstash/redis");
    idempRedis = new Redis({ url, token });
    return idempRedis;
  }
  // In production, Redis is required for cross-instance idempotency
  if (process.env.NODE_ENV === "production") {
    console.error("[SECURITY] Redis not configured — idempotency fallback to in-memory (per-instance only)");
  }
  return null;
}

// In-memory fallback for dev
const memIdempotency = new Map<string, { result: unknown; createdAt: number }>();

async function checkIdempotency(key: string): Promise<unknown | null> {
  const r = await getIdempRedis();
  if (r) {
    const raw = await r.get(`${IDEMPOTENCY_PREFIX}${key}`);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  // In-memory fallback
  const entry = memIdempotency.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > IDEMPOTENCY_TTL_S * 1000) {
    memIdempotency.delete(key);
    return null;
  }
  return entry.result;
}

async function storeIdempotency(key: string, result: unknown): Promise<void> {
  const r = await getIdempRedis();
  if (r) {
    await r.set(`${IDEMPOTENCY_PREFIX}${key}`, JSON.stringify(result), { ex: IDEMPOTENCY_TTL_S });
    return;
  }
  // In-memory fallback — evict expired entries first, then oldest if still full
  const now = Date.now();
  if (memIdempotency.size >= 500) {
    for (const [k, v] of memIdempotency) {
      if (now - (v as { createdAt: number }).createdAt > IDEMPOTENCY_TTL_S * 1000) {
        memIdempotency.delete(k);
      }
    }
    // If still over limit, evict oldest entries
    while (memIdempotency.size >= 500) {
      const oldest = memIdempotency.keys().next().value;
      if (oldest) memIdempotency.delete(oldest);
      else break;
    }
  }
  memIdempotency.set(key, { result, createdAt: Date.now() });
}

// ─── Zod Schemas ────────────────────────────────────────────────

const PrepareOrderSchema = z.object({
  action: z.literal("prepare"),
  symbol: z.string().min(1).max(20),
  side: z.enum(["Long", "Short"]),
  size: z.number().positive().finite().max(1_000_000).optional(),
  dollarSize: z.number().positive().finite().max(10_000_000).optional(),
  // Client-side cap at 200x is defense-in-depth only; actual max leverage per market
  // is enforced server-side by validateLeverage() using the exchange SDK's IMF tiers.
  leverage: z.number().min(1).max(200).finite().default(1),
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
  await ensureMarketCache().catch(() => {});

  const address = await getAuthAddress();
  if (!address) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Per-user rate limit on order operations
  if (orderLimiter) {
    const { success } = await orderLimiter.limit(address);
    if (!success) {
      return NextResponse.json({ error: "Too many requests. Please wait." }, { status: 429 });
    }
  } else {
    memCleanup();
    const { success } = memRateLimit("order:" + address, 30);
    if (!success) {
      return NextResponse.json({ error: "Too many requests. Please wait." }, { status: 429 });
    }
  }

  // Check idempotency key
  const idempotencyKey = req.headers.get("x-idempotency-key");
  if (idempotencyKey) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length > 100) {
      return NextResponse.json({ error: "Invalid idempotency key" }, { status: 400 });
    }
    const cached = await checkIdempotency(`${address}:${idempotencyKey}`);
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
      { error: "Invalid order parameters" },
      { status: 400 }
    );
  }

  const data = parsed.data;

  try {
    // ─── Prepare Order ───────────────────────────────────
    if (data.action === "prepare") {
      const market = resolveMarket(data.symbol);
      if (!market) {
        return NextResponse.json({ error: "Unknown market" }, { status: 400 });
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
      const mmf = imf / 2; // maintenance margin fraction = IMF / 2
      const maintenanceMargin = notionalValue * mmf;
      const estimatedFee = notionalValue * 0.0005;
      const priceImpact = notionalValue > 100_000 ? 0.1 : notionalValue > 10_000 ? 0.05 : 0.02;

      // Warnings
      const warnings: string[] = [];
      if (data.leverage >= 10) warnings.push("High leverage — liquidation risk is significant.");
      if (market.tier >= 4) warnings.push(`Low-liquidity market (Tier ${market.tier}) — expect higher slippage.`);

      // Cross-margin liquidation estimate using account data
      // 01 Exchange uses cross-margin: entire account equity cushions the position.
      // Liq when: accountEquity + unrealizedPnL = maintenanceMargin
      // For Long: equity + (liqPrice - entry) * size = maintenanceMargin
      //   => liqPrice = entry - (equity - maintenanceMargin) / size
      // For Short: equity + (entry - liqPrice) * size = maintenanceMargin
      //   => liqPrice = entry + (equity - maintenanceMargin) / size
      let liquidationPrice: number;
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

        // Cross-margin liq price: use total available equity
        const equityCushion = available - maintenanceMargin;
        if (equityCushion > 0 && orderSize > 0) {
          liquidationPrice = data.side === "Long"
            ? entryPrice - equityCushion / orderSize
            : entryPrice + equityCushion / orderSize;
        } else {
          // Edge case: not enough margin — liq is immediate
          liquidationPrice = entryPrice;
        }
      } else {
        // No account data: fall back to isolated-margin estimate
        const isolatedBuffer = marginRequired - maintenanceMargin;
        liquidationPrice = data.side === "Long"
          ? entryPrice - (isolatedBuffer > 0 ? isolatedBuffer / orderSize : 0)
          : entryPrice + (isolatedBuffer > 0 ? isolatedBuffer / orderSize : 0);
      }

      const previewId = await storePreview({
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

      // Don't cache prepare results — each call generates a unique previewId
      return NextResponse.json(result);
    }

    // ─── Execute Order ───────────────────────────────────
    if (data.action === "execute") {
      const preview = await consumePreview(data.previewId, address);
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

      if (idempotencyKey) await storeIdempotency(`${address}:${idempotencyKey}`, result);
      return NextResponse.json(result);
    }

    // ─── Cancel Order ────────────────────────────────────
    if (data.action === "cancel") {
      const user = await getUser(address);
      if (!user?.accountIds?.length) {
        return NextResponse.json({ error: "No account found" }, { status: 400 });
      }
      const accountId = user.accountIds[0];

      // Verify the order actually belongs to this user's account
      const account = await getAccount(accountId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawOrders = (account.orders ?? []) as Array<any>;
      const allOrderIds = new Set(rawOrders.map((o: { orderId: number }) => o.orderId));
      if (!allOrderIds.has(Number(data.orderId))) {
        return NextResponse.json({ error: "Order not found on your account" }, { status: 403 });
      }

      const result = {
        action: "cancel" as const,
        orderId: data.orderId,
        accountId,
        status: "awaiting_signature" as const,
      };

      if (idempotencyKey) await storeIdempotency(`${address}:${idempotencyKey}`, result);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    Sentry.captureException(error, { tags: { endpoint: "order" } });
    return NextResponse.json(
      { error: "Failed to process order" },
      { status: 500 }
    );
  }
}
