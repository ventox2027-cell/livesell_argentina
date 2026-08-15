-- Categorías de producto: la semilla del catálogo y el interruptor para apagar una.
--
-- ════════════════════════════════════════════════════════════════════════════
-- LA TABLA EXISTÍA VACÍA
-- ════════════════════════════════════════════════════════════════════════════
--
-- `categories` y `products.category_id` estaban en el esquema desde el
-- principio, el DTO aceptaba `categoryId`, y no había ni una fila ni un
-- endpoint que las listara. Un campo opcional que nadie puede completar.

-- ─── Poder apagar una categoría sin borrarla ────────────────────────────────
--
-- Borrar una categoría con productos adentro los deja huérfanos: `ON DELETE SET
-- NULL` los pasa a `category_id NULL`, o sea publicados y fuera de toda
-- navegación por rubro, sin que su dueño se entere.
--
-- Con esto, sacar una categoría del selector es una línea y los productos que
-- ya la tenían la conservan.
ALTER TABLE "categories"
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

-- El índice del selector: catorce filas ordenadas por posición.
CREATE INDEX IF NOT EXISTS "categories_active_position_idx"
  ON "categories" ("active", "position");

-- ─── La semilla ─────────────────────────────────────────────────────────────
--
-- Va en una migración y no en un script aparte porque el catálogo es una
-- precondición del sistema, no datos de prueba: sin categorías, publicar un
-- producto es imposible. Un entorno recién migrado tiene que poder vender.
--
-- Los identificadores son legibles y deterministas —`cat_indumentaria`, no
-- `cat_01J...`— porque este catálogo tiene que ser el MISMO en desarrollo, en
-- staging y en producción. Ver `src/modules/commerce/categorias.ts`.
--
-- `ON CONFLICT` actualiza el nombre y la posición pero NO toca `active`: si
-- alguien apagó una categoría en producción, volver a correr la migración no
-- puede resucitarla.
INSERT INTO "categories" ("id", "name", "slug", "parent_id", "position") VALUES
  ('cat_indumentaria', 'Indumentaria',                'indumentaria',  NULL,  0),
  ('cat_calzado',      'Calzado',                     'calzado',       NULL,  1),
  ('cat_belleza',      'Belleza y cuidado personal',  'belleza',       NULL,  2),
  ('cat_accesorios',   'Accesorios y joyería',        'accesorios',    NULL,  3),
  ('cat_hogar',        'Hogar y decoración',          'hogar',         NULL,  4),
  ('cat_electronica',  'Electrónica y tecnología',    'electronica',   NULL,  5),
  ('cat_deportes',     'Deportes y aire libre',       'deportes',      NULL,  6),
  ('cat_infantil',     'Bebés y niños',               'infantil',      NULL,  7),
  ('cat_mascotas',     'Mascotas',                    'mascotas',      NULL,  8),
  ('cat_libreria',     'Librería y papelería',        'libreria',      NULL,  9),
  ('cat_coleccion',    'Coleccionables y usados',     'coleccion',     NULL, 10),
  ('cat_alimentos',    'Alimentos y bebidas',         'alimentos',     NULL, 11),
  ('cat_herramientas', 'Herramientas y repuestos',    'herramientas',  NULL, 12),
  ('cat_otros',        'Otros',                       'otros',         NULL, 13)
ON CONFLICT ("id") DO UPDATE
  SET "name" = EXCLUDED."name",
      "position" = EXCLUDED."position";
