-- Moderación del chat del vivo.
--
-- Antes no se guardaba ningún mensaje: vivían en el socket y se perdían al
-- terminar el vivo. El backend aceptaba reportes de tipo CHAT_MESSAGE, pero
-- como el mensaje no existía en ningún lado, quien moderaba sólo tenía la
-- versión de quien reportaba.

-- ═══════════════════════════════════════════════════════════════════════════
-- LOS MENSAJES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Retención de 30 DÍAS. El número tiene motivo: es el tiempo en que un reporte
-- se abre, se revisa y se resuelve. Más allá de eso, un mensaje de chat de un
-- vivo no le sirve a nadie —el chat de un vivo es efímero por naturaleza— y sí
-- es una base de conversaciones privadas creciendo sin límite.

CREATE TABLE "live_chat_messages" (
  "id"                 TEXT NOT NULL,
  "live_session_id"    TEXT NOT NULL,
  "user_id"            TEXT NOT NULL,
  "text"               TEXT NOT NULL,
  -- Si un filtro lo frenó al enviarlo. NULL es el caso normal.
  --
  -- Los frenados se guardan igual, y a propósito: sin ellos no hay forma de
  -- saber si el filtro se está pasando de estricto y silenciando gente que no
  -- hizo nada.
  "blocked_by_filter"  TEXT,
  -- Borrado LÓGICO. Un mensaje eliminado es la evidencia de por qué se sancionó
  -- a alguien; borrarlo de verdad deja la sanción sin respaldo.
  "deleted_at"         TIMESTAMP(3),
  "deleted_by_user_id" TEXT,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "live_chat_messages_pkey" PRIMARY KEY ("id")
);

-- El chat de un vivo, en orden. Es la consulta de la moderación.
CREATE INDEX "live_chat_messages_live_session_id_created_at_idx"
  ON "live_chat_messages" ("live_session_id", "created_at");

-- El barrido de retención.
CREATE INDEX "live_chat_messages_created_at_idx"
  ON "live_chat_messages" ("created_at");

-- "Todo lo que escribió esta persona", para revisar un reporte.
CREATE INDEX "live_chat_messages_user_id_created_at_idx"
  ON "live_chat_messages" ("user_id", "created_at");

-- El mismo largo que valida el DTO. Última línea de defensa: un mensaje de
-- cincuenta mil caracteres en el chat de un vivo tira la pantalla de todos.
ALTER TABLE "live_chat_messages"
  ADD CONSTRAINT "live_chat_messages_text_length_check"
  CHECK (char_length("text") BETWEEN 1 AND 200);

ALTER TABLE "live_chat_messages"
  ADD CONSTRAINT "live_chat_messages_live_session_id_fkey"
  FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_chat_messages"
  ADD CONSTRAINT "live_chat_messages_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- LOS SILENCIOS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Temporales por defecto. Un silencio permanente es una expulsión, y una
-- expulsión de un espacio público la decide moderación, no el vendedor.
--
-- Lo que el vendedor puede hacer es callar a alguien DURANTE su vivo: es su
-- espacio y está pasando ahora.

CREATE TABLE "live_chat_mutes" (
  "id"              TEXT NOT NULL,
  -- NULL = en TODOS los vivos. Ese alcance lo pone moderación, nunca un
  -- vendedor: callar a alguien en toda la plataforma es una sanción.
  "live_session_id" TEXT,
  "user_id"         TEXT NOT NULL,
  "by_user_id"      TEXT NOT NULL,
  -- Obligatorio. Un silencio sin motivo no se puede revisar ni defender.
  "reason"          TEXT NOT NULL,
  -- NULL sólo para sanciones de moderación.
  "expires_at"      TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "live_chat_mutes_pkey" PRIMARY KEY ("id")
);

-- La consulta que corre en CADA mensaje. Tiene que ser barata.
CREATE INDEX "live_chat_mutes_user_id_expires_at_idx"
  ON "live_chat_mutes" ("user_id", "expires_at");

CREATE INDEX "live_chat_mutes_live_session_id_user_id_idx"
  ON "live_chat_mutes" ("live_session_id", "user_id");

-- Un motivo vacío es lo mismo que no tenerlo.
ALTER TABLE "live_chat_mutes"
  ADD CONSTRAINT "live_chat_mutes_reason_check"
  CHECK (char_length(btrim("reason")) >= 3);

-- ⛔ Nadie se silencia a sí mismo.
ALTER TABLE "live_chat_mutes"
  ADD CONSTRAINT "live_chat_mutes_no_autosilencio_check"
  CHECK ("user_id" <> "by_user_id");

ALTER TABLE "live_chat_mutes"
  ADD CONSTRAINT "live_chat_mutes_live_session_id_fkey"
  FOREIGN KEY ("live_session_id") REFERENCES "live_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_chat_mutes"
  ADD CONSTRAINT "live_chat_mutes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
