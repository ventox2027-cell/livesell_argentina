-- CreateEnum
CREATE TYPE "SellerVerificationState" AS ENUM ('NOT_STARTED', 'PENDING', 'IN_REVIEW', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SellerRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- AlterTable
ALTER TABLE "sellers" ADD COLUMN     "risk_computed_at" TIMESTAMP(3),
ADD COLUMN     "risk_level" "SellerRiskLevel" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "risk_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "seller_verifications" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "state" "SellerVerificationState" NOT NULL DEFAULT 'NOT_STARTED',
    "legal_first_name" TEXT,
    "legal_last_name" TEXT,
    "doc_type" TEXT,
    "doc_number_hash" TEXT,
    "doc_number_last4" TEXT,
    "tax_id_hash" TEXT,
    "tax_id_last4" TEXT,
    "province" TEXT,
    "city" TEXT,
    "identity_provider" TEXT,
    "identity_checked_at" TIMESTAMP(3),
    "identity_result" TEXT,
    "tax_provider" TEXT,
    "tax_checked_at" TIMESTAMP(3),
    "tax_result" TEXT,
    "submitted_at" TIMESTAMP(3),
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_verifications_seller_id_key" ON "seller_verifications"("seller_id");

-- CreateIndex
CREATE INDEX "seller_verifications_doc_number_hash_idx" ON "seller_verifications"("doc_number_hash");

-- CreateIndex
CREATE INDEX "seller_verifications_tax_id_hash_idx" ON "seller_verifications"("tax_id_hash");

-- CreateIndex
CREATE INDEX "seller_verifications_state_submitted_at_idx" ON "seller_verifications"("state", "submitted_at");

-- CreateIndex
CREATE INDEX "sellers_risk_level_status_idx" ON "sellers"("risk_level", "status");

-- AddForeignKey
ALTER TABLE "seller_verifications" ADD CONSTRAINT "seller_verifications_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
