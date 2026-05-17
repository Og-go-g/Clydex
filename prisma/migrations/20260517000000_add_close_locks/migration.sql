-- CreateTable
CREATE TABLE "close_locks" (
    "key" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "close_locks_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "idx_close_lock_expires" ON "close_locks"("expires_at");
