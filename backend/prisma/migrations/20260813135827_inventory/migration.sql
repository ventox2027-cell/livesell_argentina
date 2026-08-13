-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "inventory" (
    "id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "low_stock_threshold" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_reservations" (
    "id" TEXT NOT NULL,
    "inventory_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inventory_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_product_variant_id_key" ON "inventory"("product_variant_id");

-- CreateIndex
CREATE INDEX "inventory_reservations_user_id_status_idx" ON "inventory_reservations"("user_id", "status");

-- CreateIndex
CREATE INDEX "inventory_reservations_product_variant_id_status_idx" ON "inventory_reservations"("product_variant_id", "status");

-- CreateIndex
CREATE INDEX "inventory_reservations_inventory_id_status_idx" ON "inventory_reservations"("inventory_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_reservations_user_id_idempotency_key_key" ON "inventory_reservations"("user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_inventory_id_fkey" FOREIGN KEY ("inventory_id") REFERENCES "inventory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE PRISMA NO SABE EXPRESAR, Y ES LO QUE IMPIDE LA SOBREVENTA
--
-- Todo lo de acá abajo se escribe a mano porque el esquema de Prisma no tiene
-- forma de declararlo. No es decoración: es la última línea de defensa. El
-- código puede tener un bug; estas restricciones hacen que ese bug se
-- manifieste como una transacción rechazada y no como una unidad vendida dos
-- veces.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Invariantes del inventario ───
--
-- `reserved <= on_hand` es EL invariante del módulo. Mientras se cumpla, no
-- puede existir sobreventa, sin importar qué haga el código de arriba.

ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_on_hand_no_negativo"
  CHECK ("on_hand" >= 0);

ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_reserved_no_negativo"
  CHECK ("reserved" >= 0);

ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_reserved_no_supera_on_hand"
  CHECK ("reserved" <= "on_hand");

ALTER TABLE "inventory"
  ADD CONSTRAINT "inventory_umbral_no_negativo"
  CHECK ("low_stock_threshold" IS NULL OR "low_stock_threshold" >= 0);

-- ─── Invariantes de la reserva ───

ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "reserva_cantidad_positiva"
  CHECK ("quantity" > 0);

-- Una reserva ACTIVA no puede tener marca de final, y una terminada tiene que
-- tener la suya. Sin esto, un `UPDATE status` que se olvide del timestamp deja
-- una fila que la auditoría no puede explicar.
ALTER TABLE "inventory_reservations"
  ADD CONSTRAINT "reserva_marca_de_tiempo_coherente"
  CHECK (
    ("status" = 'ACTIVE'    AND "consumed_at" IS NULL AND "cancelled_at" IS NULL AND "expired_at" IS NULL)
    OR ("status" = 'CONSUMED'  AND "consumed_at"  IS NOT NULL)
    OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL)
    OR ("status" = 'EXPIRED'   AND "expired_at"   IS NOT NULL)
  );

-- ─── Una sola reserva ACTIVA por persona y variante ───
--
-- Índice único PARCIAL: la unicidad rige sólo sobre las filas ACTIVE. Las
-- vencidas, canceladas y consumidas se acumulan para siempre y no estorban.
--
-- Es lo que hace que un doble toque en "Comprar" —o dos pestañas, o un
-- reintento con una clave de idempotencia nueva— no pueda apartar el stock dos
-- veces. El código además reutiliza la reserva existente, pero si ese camino
-- falla, la base lo impide igual.
CREATE UNIQUE INDEX "reserva_activa_unica_por_usuario_y_variante"
  ON "inventory_reservations" ("user_id", "product_variant_id")
  WHERE "status" = 'ACTIVE';

-- ─── El barrido del reconciliador ───
--
-- Índice parcial sobre las ACTIVE nada más. El reconciliador nunca mira otra
-- cosa, y con el tiempo el 99 % de las filas van a estar terminadas: un índice
-- completo crecería sin parar para responder siempre la misma consulta chica.
CREATE INDEX "reservas_activas_por_vencimiento"
  ON "inventory_reservations" ("expires_at")
  WHERE "status" = 'ACTIVE';

-- ─── Relleno de las variantes que ya existen ───
--
-- Toda variante viva tiene que tener exactamente una fila de inventario. Sin
-- este relleno, los productos cargados antes de esta migración quedarían sin
-- inventario y la app los mostraría agotados para siempre.
--
-- Arrancan en 0: es la respuesta segura. Un vendedor que ve "0" carga su
-- stock; uno que ve un número inventado vende algo que no tiene.
--
-- El id lleva sufijo hexadecimal en vez de ULID porque SQL no genera ULIDs.
-- Los ids son opacos, así que no cambia nada salvo el aspecto.
INSERT INTO "inventory" ("id", "product_variant_id", "on_hand", "reserved", "created_at", "updated_at")
SELECT
  'inv_' || replace(gen_random_uuid()::text, '-', ''),
  v."id",
  0,
  0,
  now(),
  now()
FROM "product_variants" v
WHERE NOT EXISTS (SELECT 1 FROM "inventory" i WHERE i."product_variant_id" = v."id");
