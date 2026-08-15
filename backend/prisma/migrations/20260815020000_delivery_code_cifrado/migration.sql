-- El código de entrega pasa a guardarse cifrado.
--
-- La restricción anterior exigía exactamente seis dígitos, que era correcto
-- mientras el código se guardaba en claro. Ahora la columna contiene el sobre
-- de `shared/crypto/secretos.ts`, con el formato `v1.iv.tag.ciphertext`.
--
-- Se aceptan las DOS formas a propósito:
--
--   · seis dígitos, para los pedidos ya despachados antes de este cambio. No se
--     migran: en dos semanas no queda ninguno sin entregar, y un script que
--     cifra filas puede fallar a la mitad y dejar pedidos que nadie puede
--     confirmar;
--   · el sobre, para todo lo nuevo.
--
-- Lo que la restricción sigue impidiendo es lo que importa: que ahí adentro
-- termine cualquier otra cosa por un error de código.

ALTER TABLE "orders" DROP CONSTRAINT "orders_delivery_code_format_check";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delivery_code_format_check"
  CHECK (
    "delivery_code" IS NULL
    OR "delivery_code" ~ '^[0-9]{6}$'
    OR "delivery_code" ~ '^v[0-9]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'
  );
