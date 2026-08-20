-- «Pagar con Mercado Pago»: dónde paga la persona.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ADITIVA. NO TOCA NI UNA FILA EXISTENTE.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dos columnas que aceptan NULL. Los intentos que ya existen quedan en NULL y
-- funcionan exactamente igual: son cobros con tarjeta, donde el cobro lo hace
-- nuestro backend y no hay ningún checkout alojado que recordar.
--
-- ─── Por qué se guardan y no se recalculan ───
--
-- Porque la idempotencia depende de eso. Un segundo toque del botón tiene que
-- devolver LA MISMA preferencia; si no se guardara, habría que crear otra, y
-- dos checkouts vivos para la misma orden es el camino más corto a que alguien
-- pague dos veces.
--
-- El índice parcial `intento_en_vuelo_unico_por_orden` que ya existe se ocupa
-- del resto: garantiza un solo intento activo por orden, y ahora lo comparten
-- el cobro con tarjeta y el checkout alojado.

ALTER TABLE "payment_attempts"
  ADD COLUMN "provider_preference_id" TEXT,
  ADD COLUMN "checkout_url" TEXT;
