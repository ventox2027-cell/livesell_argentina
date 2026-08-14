-- AlterTable
ALTER TABLE "store_schedules" ADD COLUMN     "last_reopened_at" TIMESTAMP(3),
ADD COLUMN     "was_open" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "store_schedules_was_open_idx" ON "store_schedules"("was_open");
