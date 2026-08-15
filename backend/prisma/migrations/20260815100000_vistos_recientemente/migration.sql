-- Vistos recientemente.
--
-- ════════════════════════════════════════════════════════════════════════════
-- LO MÍNIMO QUE SIRVE, Y NADA MÁS
-- ════════════════════════════════════════════════════════════════════════════
--
-- «Vistos recientemente» resuelve un problema concreto y chico: alguien vio un
-- producto en un vivo, no lo compró en el momento, y media hora después no
-- puede encontrarlo. En una app donde el contenido pasa —los vivos terminan y
-- el feed cambia— volver a algo que uno vio es difícil de verdad.
--
-- Es lo único que se guarda. **No** se registra cuánto miró, en qué orden, de
-- dónde vino ni cuántas veces: eso ya no es una lista para volver, es un
-- registro de comportamiento. La diferencia entre las dos cosas es lo que
-- separa una función útil de un rastreador, y la línea la marca lo que se
-- guarda, no lo que se promete hacer con ello.
--
-- ── Una fila por persona y por cosa ──
--
-- Volver a ver algo ACTUALIZA la fila, no agrega otra. Sin la restricción
-- única, quien mira un producto diez veces lo ve diez veces en su lista y
-- tapa todo lo demás.

CREATE TABLE IF NOT EXISTS "recently_viewed" (
  "id"          TEXT NOT NULL,
  "user_id"     TEXT NOT NULL,

  -- Reutiliza el enum de los "me gusta": PRODUCT y LIVE.
  --
  -- Es el mismo concepto —«una cosa que se puede señalar»— y tener dos enums
  -- paralelos garantiza que un día alguien agregue un valor a uno y se olvide
  -- del otro. Las tiendas se agregan cuando haga falta; hoy a una tienda se
  -- llega desde un producto o desde un vivo.
  "target_type" "LikeTarget" NOT NULL,
  "target_id"   TEXT NOT NULL,

  -- Cuándo fue la ÚLTIMA vez. No la primera, y no cuántas.
  "viewed_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "recently_viewed_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recently_viewed_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Una fila por persona y por cosa.
CREATE UNIQUE INDEX IF NOT EXISTS "recently_viewed_unico"
  ON "recently_viewed" ("user_id", "target_type", "target_id");

-- El índice de la consulta: lo mío, lo más reciente primero.
CREATE INDEX IF NOT EXISTS "recently_viewed_mio_idx"
  ON "recently_viewed" ("user_id", "viewed_at" DESC);

-- El índice del barrido de retención.
CREATE INDEX IF NOT EXISTS "recently_viewed_barrido_idx"
  ON "recently_viewed" ("viewed_at");
