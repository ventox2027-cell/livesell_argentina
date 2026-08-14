-- CreateEnum
CREATE TYPE "StoreOpeningMode" AS ENUM ('ALWAYS_OPEN', 'SCHEDULED', 'LIVE_ONLY');

-- AlterTable
ALTER TABLE "sellers" ADD COLUMN     "followers_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating_sum" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "store_schedules" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "mode" "StoreOpeningMode" NOT NULL DEFAULT 'ALWAYS_OPEN',
    "timezone" TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "store_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_schedule_slots" (
    "id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "opens_at_minutes" SMALLINT NOT NULL,
    "closes_at_minutes" SMALLINT NOT NULL,

    CONSTRAINT "store_schedule_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "rating" SMALLINT NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_intents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "quantity" SMALLINT NOT NULL DEFAULT 1,
    "notified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "store_schedules_store_id_key" ON "store_schedules"("store_id");

-- CreateIndex
CREATE INDEX "store_schedule_slots_schedule_id_weekday_idx" ON "store_schedule_slots"("schedule_id", "weekday");

-- CreateIndex
CREATE INDEX "follows_seller_id_created_at_idx" ON "follows"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "follows_user_id_created_at_idx" ON "follows"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "follows_user_id_seller_id_key" ON "follows"("user_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_order_id_key" ON "reviews"("order_id");

-- CreateIndex
CREATE INDEX "reviews_seller_id_created_at_idx" ON "reviews"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_intents_product_variant_id_notified_at_idx" ON "purchase_intents"("product_variant_id", "notified_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_intents_user_id_product_variant_id_key" ON "purchase_intents"("user_id", "product_variant_id");

-- AddForeignKey
ALTER TABLE "store_schedules" ADD CONSTRAINT "store_schedules_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_schedule_slots" ADD CONSTRAINT "store_schedule_slots_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "store_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_intents" ADD CONSTRAINT "purchase_intents_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- INVARIANTES EN LA BASE
--
-- Zod ya valida estos rangos en la entrada. Estos CHECK son la capa de abajo:
-- valen para las migraciones de datos, para los scripts, y para el día que un
-- bug del código intente escribir algo imposible.
--
-- Es la misma disciplina que el módulo de inventario, donde el CHECK de
-- `reserved <= on_hand` ya atrapó un error real que los tests no vieron.
-- ═══════════════════════════════════════════════════════════════════════════

-- Un rating fuera de 1..5 no existe. Con uno de 47, el promedio del vendedor
-- quedaría arruinado para siempre y no habría forma de saber cuál fue.
ALTER TABLE "reviews"
  ADD CONSTRAINT "review_rating_entre_1_y_5"
  CHECK ("rating" >= 1 AND "rating" <= 5);

-- Un día de la semana es 0..6.
ALTER TABLE "store_schedule_slots"
  ADD CONSTRAINT "slot_dia_valido"
  CHECK ("weekday" >= 0 AND "weekday" <= 6);

-- Los minutos van de 0 a 1439 (23:59). El valor 1440 sería "las 24:00", que no
-- existe: el final del día es el 0 del siguiente.
ALTER TABLE "store_schedule_slots"
  ADD CONSTRAINT "slot_minutos_validos"
  CHECK (
    "opens_at_minutes" >= 0 AND "opens_at_minutes" <= 1439 AND
    "closes_at_minutes" >= 0 AND "closes_at_minutes" <= 1439
  );

-- Una franja que abre y cierra en el mismo minuto no es una franja: dura cero.
-- Que el cierre sea MENOR sí se permite, y significa que cruza la medianoche
-- (de 22:00 a 02:00).
ALTER TABLE "store_schedule_slots"
  ADD CONSTRAINT "slot_no_vacio"
  CHECK ("opens_at_minutes" <> "closes_at_minutes");

-- Los contadores denormalizados no pueden ser negativos. Si alguna vez lo
-- fueran, sería porque un decremento corrió sin su fila — y es mejor que la
-- escritura falle a que el vendedor muestre "-3 seguidores".
ALTER TABLE "sellers"
  ADD CONSTRAINT "seller_contadores_no_negativos"
  CHECK ("followers_count" >= 0 AND "rating_sum" >= 0 AND "rating_count" >= 0);

-- Y el promedio tiene que ser posible: la suma de N ratings de 1 a 5 está
-- entre N y 5N. Fuera de ese rango, los dos contadores se desincronizaron.
ALTER TABLE "sellers"
  ADD CONSTRAINT "seller_rating_coherente"
  CHECK (
    "rating_sum" >= "rating_count" AND "rating_sum" <= "rating_count" * 5
  );

-- Una intención de compra de cero unidades no es una intención.
ALTER TABLE "purchase_intents"
  ADD CONSTRAINT "intent_cantidad_positiva"
  CHECK ("quantity" > 0);
