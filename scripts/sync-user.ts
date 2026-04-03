import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { Pool } from "pg";

const url = process.env.HISTORY_DATABASE_URL!;
const pool = new Pool({
  connectionString: url,
  max: 3,
  ssl: url.includes("localhost") ? false : { rejectUnauthorized: false },
});

const API = "https://zo-mainnet.n1.xyz";
const WALLET = process.argv[2] || "96vjBjMrBe7TZxhig6oEHNwU7AMKZXhH5xz2FjJp8kzp";

type R = Record<string, unknown>;

async function main() {
  const userRes = await fetch(`${API}/user/${WALLET}`);
  const userData = await userRes.json();
  const ACCOUNT_ID = userData.accountIds?.[0];
  if (!ACCOUNT_ID) { console.log("No 01 account for", WALLET); process.exit(1); }
  console.log(`Account ID: ${ACCOUNT_ID}\n`);

  const infoRes = await fetch(`${API}/info`);
  const info = await infoRes.json();
  const syms: Record<number, string> = {};
  for (const m of info.markets) syms[m.marketId] = m.symbol;
  const sym = (id: number) => syms[id] ?? `MARKET-${id}`;

  async function fetchAll(baseUrl: string): Promise<R[]> {
    const all: R[] = [];
    let cursor: unknown;
    let hasMore = true;
    while (hasMore) {
      let u = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "pageSize=50";
      if (cursor) u += "&startInclusive=" + encodeURIComponent(String(cursor));
      const res = await fetch(u);
      const body = await res.json();
      const items = (body.items ?? []) as R[];
      all.push(...items);
      cursor = body.nextStartInclusive;
      hasMore = items.length >= 50 && cursor != null;
    }
    return all;
  }

  // Trades
  console.log("Trades (taker)...");
  const taker = await fetchAll(`${API}/trades?takerId=${ACCOUNT_ID}`);
  console.log("Trades (maker)...");
  const maker = await fetchAll(`${API}/trades?makerId=${ACCOUNT_ID}`);
  const allTrades = [
    ...taker.map(t => ({ ...t, role: "taker" })),
    ...maker.map(t => ({ ...t, role: "maker" })),
  ] as Array<R & { role: string }>;
  if (allTrades.length > 0) {
    const r = await pool.query(
      `INSERT INTO trade_history (id, "tradeId", "accountId", "walletAddr", "marketId", symbol, side, size, price, role, fee, "time")
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::text[], $11::numeric[], $12::timestamptz[])
       ON CONFLICT ("tradeId") DO NOTHING`,
      [
        allTrades.map(() => crypto.randomUUID()),
        allTrades.map(t => String(t.tradeId)),
        allTrades.map(() => ACCOUNT_ID),
        allTrades.map(() => WALLET),
        allTrades.map(t => Number(t.marketId)),
        allTrades.map(t => sym(Number(t.marketId))),
        allTrades.map(t => t.takerSide === "bid" ? "Long" : "Short"),
        allTrades.map(t => String(t.baseSize ?? 0)),
        allTrades.map(t => String(t.price ?? 0)),
        allTrades.map(t => t.role),
        allTrades.map(() => "0"),
        allTrades.map(t => new Date(String(t.time))),
      ],
    );
    console.log(`  Trades: ${allTrades.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No trades\n");

  // Orders
  console.log("Orders...");
  const orders = await fetchAll(`${API}/account/${ACCOUNT_ID}/orders`);
  if (orders.length > 0) {
    const r = await pool.query(
      `INSERT INTO order_history (id, "orderId", "accountId", "walletAddr", "marketId", symbol, side, "placedSize", "filledSize", "placedPrice", "orderValue", "fillMode", "fillStatus", status, "isReduceOnly", "addedAt", "updatedAt")
       SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::int[], $6::text[], $7::text[], $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[], $14::text[], $15::boolean[], $16::timestamptz[], $17::timestamptz[])
       ON CONFLICT ("orderId") DO NOTHING`,
      [
        orders.map(() => crypto.randomUUID()),
        orders.map(o => String(o.orderId)),
        orders.map(() => ACCOUNT_ID),
        orders.map(() => WALLET),
        orders.map(o => Number(o.marketId)),
        orders.map(o => String(o.marketSymbol ?? sym(Number(o.marketId)))),
        orders.map(o => o.side === "bid" ? "Long" : "Short"),
        orders.map(o => String(o.placedSize ?? 0)),
        orders.map(o => o.filledSize != null ? String(o.filledSize) : null),
        orders.map(o => String(o.placedPrice ?? 0)),
        orders.map(o => String((Number(o.placedPrice) || 0) * (Number(o.placedSize) || 0))),
        orders.map(o => String(o.fillMode ?? "unknown")),
        orders.map(o => o.filledSize != null && Number(o.filledSize) > 0 ? "Filled" : "Unfilled"),
        orders.map(o => String(o.finalizationReason ?? "unknown")),
        orders.map(o => Boolean(o.isReduceOnly)),
        orders.map(o => new Date(String(o.addedAt))),
        orders.map(o => new Date(String(o.updatedAt))),
      ],
    );
    console.log(`  Orders: ${orders.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No orders\n");

  // PnL
  console.log("PnL...");
  const pnl = await fetchAll(`${API}/account/${ACCOUNT_ID}/history/pnl`);
  if (pnl.length > 0) {
    const r = await pool.query(
      `INSERT INTO pnl_history (id, "accountId", "walletAddr", "marketId", symbol, "tradingPnl", "settledFundingPnl", "positionSize", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::numeric[], $9::timestamptz[])
       ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
      [
        pnl.map(() => crypto.randomUUID()),
        pnl.map(() => ACCOUNT_ID), pnl.map(() => WALLET),
        pnl.map(p => Number(p.marketId)), pnl.map(p => sym(Number(p.marketId))),
        pnl.map(p => String(p.tradingPnl ?? 0)), pnl.map(p => String(p.settledFundingPnl ?? 0)),
        pnl.map(p => String(p.positionSize ?? 0)), pnl.map(p => new Date(String(p.time))),
      ],
    );
    console.log(`  PnL: ${pnl.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No PnL\n");

  // Funding
  console.log("Funding...");
  const fund = await fetchAll(`${API}/account/${ACCOUNT_ID}/history/funding`);
  if (fund.length > 0) {
    const r = await pool.query(
      `INSERT INTO funding_history (id, "accountId", "walletAddr", "marketId", symbol, "fundingPnl", "positionSize", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::text[], $6::numeric[], $7::numeric[], $8::timestamptz[])
       ON CONFLICT ("walletAddr", "marketId", "time") DO NOTHING`,
      [
        fund.map(() => crypto.randomUUID()),
        fund.map(() => ACCOUNT_ID), fund.map(() => WALLET),
        fund.map(f => Number(f.marketId)), fund.map(f => sym(Number(f.marketId))),
        fund.map(f => String(f.fundingPnl ?? 0)), fund.map(f => String(f.positionSize ?? 0)),
        fund.map(f => new Date(String(f.time))),
      ],
    );
    console.log(`  Funding: ${fund.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No funding\n");

  // Deposits
  console.log("Deposits...");
  const dep = await fetchAll(`${API}/account/${ACCOUNT_ID}/history/deposit`);
  if (dep.length > 0) {
    const r = await pool.query(
      `INSERT INTO deposit_history (id, "accountId", "walletAddr", amount, balance, "tokenId", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::int[], $7::timestamptz[])
       ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
      [
        dep.map(() => crypto.randomUUID()),
        dep.map(() => ACCOUNT_ID), dep.map(() => WALLET),
        dep.map(d => String(d.amount ?? 0)), dep.map(d => String(d.balance ?? 0)),
        dep.map(d => Number(d.tokenId ?? 0)), dep.map(d => new Date(String(d.time))),
      ],
    );
    console.log(`  Deposits: ${dep.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No deposits\n");

  // Withdrawals
  console.log("Withdrawals...");
  const wd = await fetchAll(`${API}/account/${ACCOUNT_ID}/history/withdrawal`);
  if (wd.length > 0) {
    const r = await pool.query(
      `INSERT INTO withdrawal_history (id, "accountId", "walletAddr", amount, balance, fee, "destPubkey", "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::numeric[], $6::numeric[], $7::text[], $8::timestamptz[])
       ON CONFLICT ("walletAddr", "time", amount) DO NOTHING`,
      [
        wd.map(() => crypto.randomUUID()),
        wd.map(() => ACCOUNT_ID), wd.map(() => WALLET),
        wd.map(w => String(w.amount ?? 0)), wd.map(w => String(w.balance ?? 0)),
        wd.map(w => String(w.fee ?? 0)), wd.map(w => String(w.destPubkey ?? "")),
        wd.map(w => new Date(String(w.time))),
      ],
    );
    console.log(`  Withdrawals: ${wd.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No withdrawals\n");

  // Liquidations
  console.log("Liquidations...");
  const liq = await fetchAll(`${API}/account/${ACCOUNT_ID}/history/liquidation`);
  if (liq.length > 0) {
    const r = await pool.query(
      `INSERT INTO liquidation_history (id, "accountId", "walletAddr", fee, "liquidationKind", margins, "time")
       SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::numeric[], $5::text[], $6::jsonb[], $7::timestamptz[])
       ON CONFLICT ("walletAddr", "time", fee) DO NOTHING`,
      [
        liq.map(() => crypto.randomUUID()),
        liq.map(() => ACCOUNT_ID), liq.map(() => WALLET),
        liq.map(l => String(l.fee ?? 0)), liq.map(l => String(l.liquidationKind ?? "unknown")),
        liq.map(l => { const { time: _t, fee: _f, liquidationKind: _lk, ...rest } = l; return JSON.stringify(rest); }),
        liq.map(l => new Date(String(l.time))),
      ],
    );
    console.log(`  Liquidations: ${liq.length} fetched, ${r.rowCount} new\n`);
  } else console.log("  No liquidations\n");

  // Set cursors
  const now = new Date().toISOString();
  for (const type of ["trades", "orders", "pnl", "funding", "deposits", "withdrawals", "liquidations"]) {
    await pool.query(
      `INSERT INTO sync_cursors (id, "walletAddr", type, cursor, "lastSyncAt")
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       ON CONFLICT ("walletAddr", type) DO UPDATE SET cursor = $3, "lastSyncAt" = NOW()`,
      [WALLET, type, now],
    );
  }

  console.log("Done!");
  await pool.end();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
