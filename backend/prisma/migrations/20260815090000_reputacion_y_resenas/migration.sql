-- Reseñas completas y reputación real.
--
-- ════════════════════════════════════════════════════════════════════════════
-- QUÉ HABÍA
-- ════════════════════════════════════════════════════════════════════════════
--
-- Una reseña era una estrella y un comentario. `sellers.rating_sum` y
-- `rating_count` se venían actualizando desde el primer día y **ningún endpoint
-- los devolvía**: la reputación estaba calculada y no la veía nadie.

-- ─── Respuesta pública del vendedor ─────────────────────────────────────────
--
-- Una reseña sin derecho a réplica es un juicio en ausencia. El caso concreto:
-- «llegó tarde» sin poder contar que el comprador puso mal la dirección.
--
-- Va en la misma fila y no en una tabla aparte porque es UNA respuesta por
-- reseña, siempre del mismo vendedor. Una tabla sería un JOIN por reseña para
-- modelar una relación que no puede ser de muchos.
ALTER TABLE "reviews"
  ADD COLUMN IF NOT EXISTS "seller_reply"    TEXT,
  ADD COLUMN IF NOT EXISTS "seller_replied_at" TIMESTAMP(3);

-- ─── Edición y borrado ──────────────────────────────────────────────────────
--
-- `edited_at` es visible para quien lee: una reseña editada después de que el
-- vendedor respondió puede cambiarle el sentido a la respuesta, y quien la lee
-- tiene derecho a saber que eso pasó.
--
-- `deleted_at` y no un DELETE: la reseña se descuenta del promedio pero la fila
-- queda. Sin ella, un vendedor que consigue que le borren tres reseñas malas no
-- deja rastro de que existieron.
ALTER TABLE "reviews"
  ADD COLUMN IF NOT EXISTS "edited_at"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "reviews_seller_visible_idx"
  ON "reviews" ("seller_id", "deleted_at", "created_at" DESC);

-- ─── Fotos de la reseña ─────────────────────────────────────────────────────
--
-- «Llegó roto» con una foto es una cosa y sin foto es otra. Es el dato que más
-- sirve tanto a quien decide comprar como a quien tiene que resolver un
-- reclamo.
--
-- Misma forma que `product_images`: url, posición, y el borrado sigue a la
-- reseña. Reutiliza el mismo almacenamiento y la misma validación por
-- contenido; no hay una segunda arquitectura de imágenes.
CREATE TABLE IF NOT EXISTS "review_images" (
  "id"         TEXT NOT NULL,
  "review_id"  TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "position"   SMALLINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "review_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_images_review_id_fkey"
    FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "review_images_review_idx"
  ON "review_images" ("review_id", "position");

-- ─── Contadores de reputación ───────────────────────────────────────────────
--
-- ⚠️ Denormalizados a propósito, y con una condición: **cada uno se puede
-- recalcular desde las órdenes**. Un contador que no se puede recomputar es un
-- número que, cuando se desincroniza, nadie sabe si está mal.
--
-- Por qué no se calculan al vuelo: el perfil público de un vendedor es de las
-- pantallas más visitadas y contar todas sus órdenes entregadas en cada visita
-- es un `COUNT` sobre una tabla que crece para siempre.
--
-- `sales_count`   = órdenes que llegaron a DELIVERED. No «ventas»: entregas.
--                   Una venta cobrada y después cancelada no es una venta
--                   cumplida y no cuenta.
-- `cancelled_count` = las que el VENDEDOR canceló después de cobrar. No
--                   incluye las que canceló el comprador ni las que vencieron
--                   sin pagar: eso no dice nada del vendedor.
--
-- El cumplimiento sale de los dos: entregadas / (entregadas + canceladas).
-- Con menos de 5 operaciones no se muestra —ver `reputacion.ts`—: «100 % de
-- cumplimiento» sobre una sola venta no es información, es ruido.
ALTER TABLE "sellers"
  ADD COLUMN IF NOT EXISTS "sales_count"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cancelled_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "sellers"
  DROP CONSTRAINT IF EXISTS "sellers_contadores_no_negativos";
ALTER TABLE "sellers"
  ADD CONSTRAINT "sellers_contadores_no_negativos"
  CHECK ("sales_count" >= 0 AND "cancelled_count" >= 0 AND "rating_count" >= 0);

-- ─── Backfill ───────────────────────────────────────────────────────────────
--
-- Los datos ya existen en `orders`: los contadores nacen con el valor correcto
-- en vez de arrancar en cero y mentir hasta la próxima venta.
UPDATE "sellers" s SET "sales_count" = (
  SELECT COUNT(*) FROM "orders" o
  WHERE o."seller_id" = s."id" AND o."status" = 'DELIVERED'
);

UPDATE "sellers" s SET "cancelled_count" = (
  SELECT COUNT(*) FROM "orders" o
  WHERE o."seller_id" = s."id"
    AND o."status" = 'CANCELLED'
    AND o."paid_at" IS NOT NULL
);
