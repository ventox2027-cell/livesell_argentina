-- LIVE programado, recordatorios y preferencias de aviso.

-- ─── Cuándo va a empezar ────────────────────────────────────────────────────
--
-- El estado SCHEDULED ya existía y era el valor por omisión de toda sesión: se
-- creaba «programada» y arrancaba enseguida. Lo que no existía era la FECHA, y
-- sin fecha no hay nada que anunciar ni a quién avisarle.
ALTER TABLE "live_sessions"
  ADD COLUMN IF NOT EXISTS "scheduled_for" TIMESTAMP(3);

-- El índice de la cartelera —«próximos vivos»— y del barrido que avisa.
--
-- Parcial: las sesiones con fecha son un puñado frente a todas las que ya
-- pasaron, y un índice sobre la tabla entera sería casi todo NULLs.
CREATE INDEX IF NOT EXISTS "live_sessions_agenda_idx"
  ON "live_sessions" ("scheduled_for")
  WHERE "scheduled_for" IS NOT NULL;

-- Ya se avisó que estaba por empezar. Evita mandar el mismo aviso dos veces si
-- el barrido corre dos veces en la misma ventana.
ALTER TABLE "live_sessions"
  ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMP(3);

-- ─── «Recordarme» ───────────────────────────────────────────────────────────
--
-- ⚠️ Es distinto de seguir al vendedor, y por eso es una tabla y no un filtro
-- sobre `follows`.
--
-- Seguir es «me interesa esta tienda en general». Recordarme es «este vivo, el
-- jueves a las 20». Alguien puede querer lo segundo sin lo primero —vio el
-- anuncio de una venta puntual— y sobre todo puede seguir a un vendedor sin
-- querer que le suene el teléfono en cada transmisión.
--
-- Mezclarlas significaría o avisarle a todos los seguidores de todo, o no poder
-- avisarle a quien lo pidió expresamente.
CREATE TABLE IF NOT EXISTS "live_reminders" (
  "id"              TEXT NOT NULL,
  "user_id"         TEXT NOT NULL,
  "live_session_id" TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "live_reminders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "live_reminders_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "live_reminders_live_session_id_fkey"
    FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE
);

-- Un recordatorio por persona y por vivo. Tocar el botón dos veces no manda
-- dos avisos.
CREATE UNIQUE INDEX IF NOT EXISTS "live_reminders_unico"
  ON "live_reminders" ("user_id", "live_session_id");

-- El índice del aviso: a quién le tengo que avisar de ESTE vivo.
CREATE INDEX IF NOT EXISTS "live_reminders_por_vivo_idx"
  ON "live_reminders" ("live_session_id");

-- ─── Qué avisos NO quiere recibir ───────────────────────────────────────────
--
-- ⚠️ Se guarda lo APAGADO, no lo encendido.
--
-- Con una lista de encendidos, cada categoría nueva nace apagada para todos los
-- que ya existían, y hay que acordarse de hacer un backfill en cada release.
-- Con una lista de apagados, lo nuevo nace encendido y quien no tocó nada
-- recibe todo — que es lo que quiere alguien que nunca entró a esta pantalla.
--
-- Un arreglo y no una tabla: son ocho valores como mucho, se leen siempre
-- enteros junto con el usuario, y una tabla sería un JOIN por cada aviso que se
-- crea.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "muted_notification_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
