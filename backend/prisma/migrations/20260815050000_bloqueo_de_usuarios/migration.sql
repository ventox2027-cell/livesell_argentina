-- Bloqueo entre personas.
--
-- Es unilateral y asimétrico: si A bloquea a B, B no se entera y desde su lado
-- todo se ve igual. Avisarle a alguien que lo bloquearon es darle un motivo y
-- un objetivo, y quien bloquea suele estar tratando de que la otra persona
-- pierda interés, no de confrontarla.
--
-- El chat es la excepción: ahí el silencio funciona en los dos sentidos, porque
-- de nada sirve que A no lea a B si B puede seguir escribiéndole.

CREATE TABLE "user_blocks" (
  "id"         TEXT NOT NULL,
  "blocker_id" TEXT NOT NULL,
  "blocked_id" TEXT NOT NULL,
  "reason"     TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- Una persona bloquea a otra UNA vez. Bloquear dos veces es idempotente, no un
-- error: alguien que toca el botón dos veces por nervios no tiene por qué ver
-- un mensaje rojo.
CREATE UNIQUE INDEX "user_blocks_blocker_id_blocked_id_key"
  ON "user_blocks" ("blocker_id", "blocked_id");

-- "¿A quién bloqueé?" — la lista que se muestra en el perfil.
CREATE INDEX "user_blocks_blocker_id_created_at_idx"
  ON "user_blocks" ("blocker_id", "created_at");

-- "¿Quiénes bloquearon a esta persona?" — lo consulta el chat en cada mensaje,
-- así que tiene que ser barato.
CREATE INDEX "user_blocks_blocked_id_idx" ON "user_blocks" ("blocked_id");

-- ⛔ Nadie se bloquea a sí mismo.
--
-- No rompe nada —el chat consigo mismo no existe— pero es un estado sin sentido
-- que después aparece en un informe y hace perder media hora averiguando qué
-- pasó. Se frena en la base porque es donde no se puede saltear.
ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_no_autobloqueo_check"
  CHECK ("blocker_id" <> "blocked_id");

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blocker_id_fkey"
  FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_blocks"
  ADD CONSTRAINT "user_blocks_blocked_id_fkey"
  FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
