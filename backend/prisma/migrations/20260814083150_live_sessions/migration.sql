-- CreateEnum
CREATE TYPE "LiveSessionState" AS ENUM ('SCHEDULED', 'STARTING', 'LIVE', 'RECONNECTING', 'ENDING', 'ENDED', 'FAILED');

-- CreateTable
CREATE TABLE "live_sessions" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cover_url" TEXT,
    "state" "LiveSessionState" NOT NULL DEFAULT 'SCHEDULED',
    "room_name" TEXT NOT NULL,
    "featured_variant_id" TEXT,
    "featured_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "peak_viewers" INTEGER,
    "unique_viewers" INTEGER,
    "total_orders" INTEGER,
    "gross_amount" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_session_products" (
    "id" TEXT NOT NULL,
    "live_session_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "position" SMALLINT NOT NULL DEFAULT 0,
    "featured_count" INTEGER NOT NULL DEFAULT 0,
    "last_featured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_session_products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "live_sessions_room_name_key" ON "live_sessions"("room_name");

-- CreateIndex
CREATE INDEX "live_sessions_state_started_at_idx" ON "live_sessions"("state", "started_at");

-- CreateIndex
CREATE INDEX "live_sessions_seller_id_created_at_idx" ON "live_sessions"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "live_session_products_live_session_id_position_idx" ON "live_session_products"("live_session_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_products_live_session_id_product_id_key" ON "live_session_products"("live_session_id", "product_id");

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_products" ADD CONSTRAINT "live_session_products_live_session_id_fkey" FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session_products" ADD CONSTRAINT "live_session_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
