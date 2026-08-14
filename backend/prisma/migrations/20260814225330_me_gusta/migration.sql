-- CreateEnum
CREATE TYPE "LikeTarget" AS ENUM ('LIVE', 'PRODUCT');

-- AlterTable
ALTER TABLE "live_sessions" ADD COLUMN     "likes_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "likes_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "likes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_type" "LikeTarget" NOT NULL,
    "target_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "likes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "likes_target_type_target_id_idx" ON "likes"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "likes_user_id_target_type_target_id_key" ON "likes"("user_id", "target_type", "target_id");

-- AddForeignKey
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un contador negativo es un bug, no un estado.
--
-- Si aparece, alguien resto un "me gusta" que nunca se sumo. Es mejor que
-- falle el UPDATE y se vea en los logs que mostrar "-3 me gusta" en el feed.
ALTER TABLE "live_sessions"
  ADD CONSTRAINT "live_likes_no_negativos_check" CHECK ("likes_count" >= 0);

ALTER TABLE "products"
  ADD CONSTRAINT "product_likes_no_negativos_check" CHECK ("likes_count" >= 0);
