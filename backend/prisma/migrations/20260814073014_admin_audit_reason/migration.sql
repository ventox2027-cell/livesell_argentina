-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "reason" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");
