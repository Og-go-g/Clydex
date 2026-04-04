#!/bin/bash
# ============================================================
# Reset history DB and run full sync
# Run on server: bash scripts/reset-and-sync.sh
# ============================================================
set -e

echo "=== Step 1: Drop all history tables ==="
sudo -u postgres psql -d clydex_history -c "
DROP TABLE IF EXISTS trade_history CASCADE;
DROP TABLE IF EXISTS order_history CASCADE;
DROP TABLE IF EXISTS pnl_history CASCADE;
DROP TABLE IF EXISTS funding_history CASCADE;
DROP TABLE IF EXISTS deposit_history CASCADE;
DROP TABLE IF EXISTS withdrawal_history CASCADE;
DROP TABLE IF EXISTS liquidation_history CASCADE;
DROP TABLE IF EXISTS sync_cursors CASCADE;
DROP TABLE IF EXISTS volume_calendar CASCADE;
DROP TABLE IF EXISTS pnl_totals CASCADE;
DROP TABLE IF EXISTS _prisma_migrations CASCADE;
"
echo "   Tables dropped."

echo ""
echo "=== Step 2: Recreate tables via Prisma ==="
npx prisma db push --schema prisma/history.prisma --accept-data-loss
echo "   Tables created with camelCase columns."

echo ""
echo "=== Step 3: Verify columns ==="
sudo -u postgres psql -d clydex_history -c "
SELECT column_name FROM information_schema.columns
WHERE table_name = 'trade_history'
ORDER BY ordinal_position;
"

echo ""
echo "=== Step 4: Ready to sync ==="
echo "Run the sync command now."
