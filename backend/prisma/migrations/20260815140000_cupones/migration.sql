-- Cupones de descuento.
--
-- El descuento sale del bolsillo del vendedor: VendoX no lo financia, y la
-- comisión se cobra sobre lo que se pagó de verdad. Ver `commerce/cupones.ts`.

CREATE TYPE "CouponType" AS ENUM ('PORCENTAJE', 'MONTO_FIJO');

CREATE TABLE "coupons" (
  "id"              TEXT NOT NULL,
  "seller_id"       TEXT NOT NULL,
  "codigo"          TEXT NOT NULL,
  "tipo"            "CouponType" NOT NULL,
  "valor"           INTEGER NOT NULL,
  "minimo_centavos" INTEGER,
  "tope_centavos"   INTEGER,
  "desde"           TIMESTAMP(3),
  "hasta"           TIMESTAMP(3),
  "usos_maximos"    INTEGER,
  "usos"            INTEGER NOT NULL DEFAULT 0,
  "activo"          BOOLEAN NOT NULL DEFAULT true,
  "deleted_at"      TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- Único POR VENDEDOR, no global: dos tiendas pueden tener las dos un
-- «VERANO25», y hacerlos globales sería que la primera se quede con los
-- códigos buenos.
CREATE UNIQUE INDEX "coupons_seller_id_codigo_key" ON "coupons"("seller_id", "codigo");
CREATE INDEX "coupons_seller_id_activo_idx" ON "coupons"("seller_id", "activo");

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "coupon_redemptions" (
  "id"                 TEXT NOT NULL,
  "coupon_id"          TEXT NOT NULL,
  "user_id"            TEXT NOT NULL,
  "order_id"           TEXT NOT NULL,
  "descuento_centavos" INTEGER NOT NULL,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coupon_redemptions_order_id_key" ON "coupon_redemptions"("order_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- Un cupón, una vez por persona
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Va acá y no en un `if`: dos pedidos simultáneos de la misma persona pasarían
-- los dos por cualquier comprobación previa. Es la misma disciplina que las
-- reservas de stock.
CREATE UNIQUE INDEX "coupon_redemptions_coupon_id_user_id_key"
  ON "coupon_redemptions"("coupon_id", "user_id");

CREATE INDEX "coupon_redemptions_coupon_id_created_at_idx"
  ON "coupon_redemptions"("coupon_id", "created_at");

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_coupon_id_fkey"
  FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Lo que el código valida, la base lo exige
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `exigirCuponValido` ya rechaza todo esto al crear. Estos CHECK existen porque
-- el código se puede saltear: un UPDATE a mano desde una consola, una migración
-- futura mal escrita, un endpoint nuevo que se olvide de llamar a la validación.

-- Un descuento del 100 % no es un cupón: es regalar el producto.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_valor_razonable"
  CHECK (
    ("tipo" = 'PORCENTAJE' AND "valor" BETWEEN 1 AND 80)
    OR ("tipo" = 'MONTO_FIJO' AND "valor" >= 100)
  );

-- El tope sólo significa algo sobre un porcentaje.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_tope_solo_en_porcentaje"
  CHECK ("tope_centavos" IS NULL OR "tipo" = 'PORCENTAJE');

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_montos_no_negativos"
  CHECK (
    ("minimo_centavos" IS NULL OR "minimo_centavos" >= 0)
    AND ("tope_centavos" IS NULL OR "tope_centavos" >= 100)
    AND ("usos_maximos" IS NULL OR "usos_maximos" >= 1)
    AND "usos" >= 0
  );

ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_ventana_coherente"
  CHECK ("desde" IS NULL OR "hasta" IS NULL OR "hasta" > "desde");

-- ─────────────────────────────────────────────────────────────────────────────
-- El límite de usos, en la base
-- ─────────────────────────────────────────────────────────────────────────────
--
-- El canje usa un UPDATE condicional que sólo incrementa si todavía queda cupo.
-- Este CHECK es la red debajo: si alguna vez ese UPDATE se escribe mal, la fila
-- no puede pasarse del límite igual.
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_no_supera_el_limite"
  CHECK ("usos_maximos" IS NULL OR "usos" <= "usos_maximos");

-- Un descuento negativo sumaría al total.
ALTER TABLE "coupon_redemptions"
  ADD CONSTRAINT "coupon_redemptions_descuento_positivo"
  CHECK ("descuento_centavos" > 0);
