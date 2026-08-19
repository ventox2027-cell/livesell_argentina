-- Que dos altas del mismo producto no dejen dos productos.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EL CASO QUE NINGÚN BOTÓN DESHABILITADO ARREGLA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El teléfono manda `POST /products`. El servidor lo crea. La respuesta se
-- pierde —un timeout, la red que cambia de celda, la app que pasa a segundo
-- plano—. Para el teléfono eso es indistinguible de «no llegó», así que
-- reintenta. Y aparece el segundo producto.
--
-- Deshabilitar el botón mientras viaja la petición no cubre nada de esto:
-- el problema no es el segundo toque, es el segundo VIAJE.
--
-- Con la clave, la segunda petición trae la misma que la primera y el servidor
-- devuelve el producto que ya existe.
--
-- ─── Por qué el índice es por tienda y no global ───
--
-- Dos vendedores distintos podrían generar la misma clave —son aleatorias,
-- pero nada lo garantiza— y una colisión entre tiendas haría que el segundo
-- recibiera el producto del primero. Acotarlo a `store_id` hace que eso sea
-- imposible por construcción.
--
-- ─── Por qué se puede agregar sin tocar los datos existentes ───
--
-- La columna es NULL en todo lo que ya existe, y PostgreSQL considera cada
-- NULL distinto de los demás dentro de un índice único. Mil productos viejos
-- con la clave en NULL conviven sin chocar.
--
-- Eso también significa que un cliente que NO mande la clave sigue pudiendo
-- crear productos —y sigue pudiendo duplicarlos—. Es deliberado: una app vieja
-- instalada en un teléfono no se puede actualizar desde acá, y romperle el
-- alta sería peor que dejarla como estaba.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "products_store_id_idempotency_key_key"
  ON "products" ("store_id", "idempotency_key");
