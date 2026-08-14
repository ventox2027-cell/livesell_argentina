-- Busqueda de texto sobre el catalogo.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUE FULL-TEXT Y NO ILIKE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `ILIKE '%remera%'` no usa indice: recorre la tabla entera en cada busqueda.
-- Con mil productos no se nota; con cien mil, la pantalla de busqueda es lo
-- primero que se cae.
--
-- Y ademas no entiende castellano. `to_tsvector('spanish', ...)` aplica el
-- stemmer: "zapatos" encuentra "zapato", "camisas" encuentra "camisa". Sin eso,
-- media busqueda no devuelve nada y la persona cree que no vendemos eso.
--
-- ─── Columna generada, no un trigger ───
--
-- `GENERATED ALWAYS AS ... STORED` la mantiene PostgreSQL sola. Un trigger
-- hace lo mismo y hay que acordarse de que existe: cuando alguien escriba un
-- UPDATE masivo desde una consola, el trigger corre igual pero nadie sabe por
-- que la tabla tarda.
--
-- `coalesce` en los dos campos: si la descripcion es NULL, la concatenacion
-- entera daria NULL y el producto se volveria imposible de encontrar por su
-- propio nombre.
--
-- Pesos: el nombre pesa mas que la descripcion. Alguien que busca "buzo" quiere
-- productos que SE LLAMAN buzo, no los que lo mencionan al pasar.
ALTER TABLE "products"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', coalesce("name", '')), 'A')
    || setweight(to_tsvector('spanish', coalesce("description", '')), 'B')
  ) STORED;

-- GIN y no GiST: GIN es mas lento de escribir y mucho mas rapido de leer, y un
-- catalogo se lee ordenes de magnitud mas veces de las que se escribe.
CREATE INDEX "products_search_vector_idx" ON "products" USING GIN ("search_vector");

-- El indice del feed: lo activo y visible, ordenado por fecha.
--
-- Sin esto, cada scroll del feed ordena la tabla entera en memoria. Es la
-- consulta mas frecuente de toda la aplicacion.
-- Sin predicado parcial: Prisma no representa indices parciales, y uno que el
-- schema no describe lo borra en la siguiente migracion. Un indice de mas
-- sobre filas borradas cuesta poco; perder el indice del feed cuesta la
-- pantalla mas usada de la app.
CREATE INDEX "products_feed_idx"
  ON "products" ("status", "deleted_at", "created_at" DESC);
