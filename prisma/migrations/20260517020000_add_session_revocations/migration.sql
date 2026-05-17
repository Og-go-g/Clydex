-- CreateTable
CREATE TABLE "session_revocations" (
    "wallet_addr" TEXT NOT NULL,
    "revoked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_revocations_pkey" PRIMARY KEY ("wallet_addr")
);
