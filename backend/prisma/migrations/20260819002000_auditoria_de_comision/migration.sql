-- Por qué se le cobró a esta orden lo que se le cobró.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- CUATRO COLUMNAS QUE NO CAMBIAN NINGÚN IMPORTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `platform_fee_bps` ya guarda CUÁNTO. Esto guarda POR QUÉ, y las entradas con
-- las que se decidió.
--
-- Sin ellas, dentro de seis meses una orden al 3 % y otra al 4 % del mismo
-- vendedor son indistinguibles de un error. La pregunta que llega a soporte no
-- es «cuánto me cobraron» —eso ya está— sino «por qué a mí me cobraron
-- distinto», y hoy esa no se puede responder consultando la base.
--
-- ─── Las cuatro ───
--
--   platform_fee_reason         BASE / VOLUMEN_BUSINESS / DEVOLUCIONES_ALTAS…
--   platform_fee_weekly_volume  el promedio semanal con el que se decidió
--   platform_fee_refund_rate_bps la tasa de devolución medida
--   platform_fee_evaluated_at   el final de la ventana móvil que se usó
--
-- Las tres últimas son las ENTRADAS de la decisión, no su resultado. Van
-- congeladas porque la ventana es móvil: recalcular mañana da otro número, así
-- que sin guardarlas no hay forma de reconstruir por qué esta orden cayó en el
-- tramo que cayó. Es la misma razón por la que `platform_fee_bps` existe en vez
-- de leerse de la configuración.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- TODAS NULLABLE, Y NINGUNA SE RELLENA HACIA ATRÁS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Las órdenes anteriores a la comisión por volumen quedan en NULL y así se
-- quedan. Ponerles 'BASE' sería casi cierto —todas pagaron la tasa base— pero
-- afirmaría que alguien evaluó tramos cuando no existían. NULL dice «esto es de
-- antes», que es la verdad.
--
-- ⚠️ No se toca un solo importe. Ninguna orden existente cambia de comisión, de
-- neto ni de estado. Esta migración es puramente aditiva: si se revierte el
-- código, las columnas quedan sin escribirse y nada se rompe.
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "platform_fee_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "platform_fee_weekly_volume" INTEGER,
  ADD COLUMN IF NOT EXISTS "platform_fee_refund_rate_bps" INTEGER,
  ADD COLUMN IF NOT EXISTS "platform_fee_evaluated_at" TIMESTAMP(3);

-- Los dos son porcentajes en puntos básicos: no pueden ser negativos, y una
-- tasa de devolución no puede pasar del 100 %.
--
-- El cortafuegos existe por lo mismo que `orden_comision_razonable`: un valor
-- mal calculado que quede guardado se descubre al liquidar, no al escribirlo.
ALTER TABLE "orders"
  ADD CONSTRAINT "orden_auditoria_comision_coherente"
  CHECK (
    ("platform_fee_weekly_volume" IS NULL OR "platform_fee_weekly_volume" >= 0)
    AND ("platform_fee_refund_rate_bps" IS NULL
         OR ("platform_fee_refund_rate_bps" >= 0 AND "platform_fee_refund_rate_bps" <= 10000))
  );
