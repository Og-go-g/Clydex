-- CreateTable
CREATE TABLE "terms_acceptance" (
    "wallet_addr" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_acceptance_pkey" PRIMARY KEY ("wallet_addr")
);
