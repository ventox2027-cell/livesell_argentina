-- Promociones pagas.
--
-- Pagar compra un LUGAR del feed, no puntaje. Ver `commerce/promociones.ts`.

CREATE TYPE "PromotionType" AS ENUM ('PRODUCTO_EN_FEED', 'VIVO_PROGRAMADO');

CREATE TABLE "promotions" (
  "id"           TEXT NOT NULL,
  "seller_id"    TEXT NOT NULL,
  "tipo"         "PromotionType" NOT NULL,
  "target_id"    TEXT NOT NULL,
  "desde"        TIMESTAMP(3) NOT NULL,
  "hasta"        TIMESTAMP(3) NOT NULL,
  "creditos"     INTEGER NOT NULL,
  "cancelada"    BOOLEAN NOT NULL DEFAULT false,
  "cancelada_el" TIMESTAMP(3),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "promotions_tipo_desde_hasta_idx" ON "promotions"("tipo", "desde", "hasta");
CREATE INDEX "promotions_seller_id_created_at_idx" ON "promotions"("seller_id", "created_at");

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_ventana_coherente" CHECK ("hasta" > "desde");

-- Una promoción gratis no es una promoción: sería una forma de saltarse el
-- descuento de créditos escribiendo un cero.
ALTER TABLE "promotions"
  ADD CONSTRAINT "promotions_cuesta_algo" CHECK ("creditos" > 0);

-- ─────────────────────────────────────────────────────────────────────────────
-- El libro mayor de créditos
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No hay una columna `creditos` en `sellers`. El saldo es la suma de estas
-- filas: un saldo suelto se corrompe con un UPDATE mal escrito y después nadie
-- puede reconstruir de dónde salió.
CREATE TABLE "promotion_credits" (
  "id"           TEXT NOT NULL,
  "seller_id"    TEXT NOT NULL,
  "delta"        INTEGER NOT NULL,
  "motivo"       TEXT NOT NULL,
  "otorgado_por" TEXT,
  "promotion_id" TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promotion_credits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "promotion_credits_seller_id_created_at_idx"
  ON "promotion_credits"("seller_id", "created_at");

ALTER TABLE "promotion_credits"
  ADD CONSTRAINT "promotion_credits_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un movimiento de cero no dice nada y ensucia el libro.
ALTER TABLE "promotion_credits"
  ADD CONSTRAINT "promotion_credits_delta_no_nulo" CHECK ("delta" <> 0);
