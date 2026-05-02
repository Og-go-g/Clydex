-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "idx_rl_bucket_window" ON "rate_limit_buckets"("window_start");

-- CreateTable
CREATE TABLE "nonces" (
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "nonces_pkey" PRIMARY KEY ("value")
);

-- CreateIndex
CREATE INDEX "idx_nonce_expires" ON "nonces"("expires_at");

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "idx_idem_expires" ON "idempotency_keys"("expires_at");

-- CreateTable
CREATE TABLE "order_previews" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "order_previews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_preview_expires" ON "order_previews"("expires_at");
