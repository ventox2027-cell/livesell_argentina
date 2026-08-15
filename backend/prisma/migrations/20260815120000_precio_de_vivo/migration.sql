-- Precio exclusivo del vivo.
--
-- ════════════════════════════════════════════════════════════════════════════
-- POR QUÉ NO ES UN CAMPO EN EL PRODUCTO
-- ════════════════════════════════════════════════════════════════════════════
--
-- Lo simple sería `products.live_price_cents`. Está mal por tres motivos:
--
--   · un producto puede estar en dos vivos —el de hoy y el programado para el
--     jueves— con precios distintos;
--   · el descuento tiene ventana, y una ventana pegada al producto obliga a
--     mirar la hora en cada consulta del catálogo;
--   · y, sobre todo, **no habría rastro**. Un precio que se pisa no deja
--     historia, y un reclamo de «me cobraron más de lo que decía» se responde
--     con la palabra de uno contra la del otro.
--
-- Va en `live_session_products`, que es la fila que ya representa «este
-- producto, en este vivo». Ahí el precio pertenece al par y queda para siempre.

ALTER TABLE "live_session_products"
  ADD COLUMN IF NOT EXISTS "live_price_cents" INTEGER,
  ADD COLUMN IF NOT EXISTS "live_price_from"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "live_price_until" TIMESTAMP(3);

-- ─── El precio con descuento tiene que ser MENOR ────────────────────────────
--
-- Es la línea entre un descuento y una mentira.
--
-- Sin este CHECK, un vendedor podría poner un "precio LIVE" mayor que el normal
-- y la app mostraría el precio real tachado al lado de uno más caro. Es el
-- patrón oscuro más viejo del comercio electrónico y la ley de defensa del
-- consumidor argentina lo trata como publicidad engañosa.
--
-- El mínimo de 100 centavos es el mismo piso que tiene cualquier precio del
-- sistema: un producto de $0 no es un descuento, es un error de carga.
ALTER TABLE "live_session_products"
  DROP CONSTRAINT IF EXISTS "live_price_positivo";
ALTER TABLE "live_session_products"
  ADD CONSTRAINT "live_price_positivo"
  CHECK ("live_price_cents" IS NULL OR "live_price_cents" >= 100);

-- ─── La ventana tiene que tener sentido ─────────────────────────────────────
--
-- Un desde posterior al hasta define una ventana vacía: el descuento nunca
-- estaría activo, y el vendedor lo vería configurado sin entender por qué no
-- se aplica.
ALTER TABLE "live_session_products"
  DROP CONSTRAINT IF EXISTS "live_price_ventana_valida";
ALTER TABLE "live_session_products"
  ADD CONSTRAINT "live_price_ventana_valida"
  CHECK (
    "live_price_from" IS NULL
    OR "live_price_until" IS NULL
    OR "live_price_from" < "live_price_until"
  );

-- ════════════════════════════════════════════════════════════════════════════
-- QUÉ SE PAGÓ REALMENTE
-- ════════════════════════════════════════════════════════════════════════════
--
-- ⚠️ La comisión de VendoX es 6 % sobre el valor del producto EFECTIVAMENTE
-- pagado. Con precios de vivo, «el precio del producto» deja de ser una sola
-- cosa: está el de lista y está el que pagó esta persona.
--
-- `order_items.unit_price_cents` ya guarda lo que se cobró, así que la comisión
-- sigue saliendo bien sin tocar nada. Lo que falta es poder DECIR de dónde
-- salió ese número seis meses después, cuando alguien pregunte por qué dos
-- órdenes del mismo producto tienen precios distintos.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "live_session_id" TEXT,
  ADD COLUMN IF NOT EXISTS "list_price_cents" INTEGER;

-- Sin clave foránea a propósito: un vivo se puede borrar y la orden tiene que
-- sobrevivir con su historia intacta. Es el mismo criterio que
-- `shipping_address`, que guarda una copia y no una referencia.
CREATE INDEX IF NOT EXISTS "orders_por_vivo_idx"
  ON "orders" ("live_session_id", "created_at" DESC)
  WHERE "live_session_id" IS NOT NULL;

COMMENT ON COLUMN "orders"."list_price_cents" IS
  'El precio de lista al momento de la compra. Si difiere del unitario del item, hubo precio de vivo.';
