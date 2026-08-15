-- VendoX Pro.
--
-- Una tabla que no sabe cobrar: no hay ninguna columna que nombre un proveedor
-- de pago. Ver el comentario de `SellerMembership` en el esquema.

CREATE TYPE "MembershipPlan" AS ENUM ('FREE', 'PRO');
CREATE TYPE "MembershipPeriod" AS ENUM ('MENSUAL', 'ANUAL');
CREATE TYPE "MembershipOrigin" AS ENUM ('GRATIS', 'CORTESIA', 'PRUEBA', 'PAGO');

CREATE TABLE "seller_memberships" (
  "id"            TEXT NOT NULL,
  "seller_id"     TEXT NOT NULL,
  "plan"          "MembershipPlan" NOT NULL DEFAULT 'FREE',
  "vigente_hasta" TIMESTAMP(3),
  "periodo"       "MembershipPeriod",
  "origen"        "MembershipOrigin" NOT NULL DEFAULT 'GRATIS',
  "nota"          TEXT,
  "otorgado_por"  TEXT,
  "avisado_el"    TIMESTAMP(3),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "seller_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "seller_memberships_seller_id_key" ON "seller_memberships"("seller_id");

-- El barrido que avisa los que vencen pronto filtra por las dos columnas.
CREATE INDEX "seller_memberships_plan_vigente_hasta_idx"
  ON "seller_memberships"("plan", "vigente_hasta");

ALTER TABLE "seller_memberships"
  ADD CONSTRAINT "seller_memberships_seller_id_fkey"
  FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- La última línea de defensa
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Un PRO sin fecha de vencimiento sería Pro para siempre. `planVigente()` ya lo
-- trata como vencido, pero eso es código y el código se puede saltear: un
-- `UPDATE` a mano desde una consola, una migración futura mal escrita.
--
-- Acá no entra.
ALTER TABLE "seller_memberships"
  ADD CONSTRAINT "seller_memberships_pro_vence"
  CHECK ("plan" = 'FREE' OR "vigente_hasta" IS NOT NULL);

-- Y Free no lleva período: no se renueva nada.
ALTER TABLE "seller_memberships"
  ADD CONSTRAINT "seller_memberships_free_sin_periodo"
  CHECK ("plan" = 'PRO' OR "periodo" IS NULL);
