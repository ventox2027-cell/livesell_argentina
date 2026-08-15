-- VendoX es 18+. La fecha de nacimiento declarada.
--
-- `DATE` y no `TIMESTAMP`: una fecha de nacimiento no tiene hora, y guardarla
-- como timestamp la vuelve sensible al huso horario. En un país a UTC-3,
-- `2008-03-15T00:00:00Z` leído en local es el 14 de marzo, y alguien cumple
-- años un día tarde.
--
-- Las dos columnas son NULL para todas las cuentas que ya existen. No se
-- inventa una fecha ni se bloquea a nadie de entrada: se le va a pedir cuando
-- intente comprar o abrir su tienda, que es cuando hace falta.

ALTER TABLE "users"
  ADD COLUMN "birth_date" DATE,
  ADD COLUMN "birth_date_declared_at" TIMESTAMP(3);

-- Última línea de defensa contra una fecha absurda escrita por un error de
-- código.
--
-- ⚠️ Los límites son FIJOS y no `CURRENT_DATE`: PostgreSQL exige que las
-- funciones de un CHECK sean IMMUTABLE, y `CURRENT_DATE` no lo es. Un
-- constraint que se mueve con el reloj además rompería una restauración de
-- respaldo hecha en otra fecha.
--
-- El techo es 2030 y no "hoy": la comprobación fina de "no puede ser futura"
-- vive en `edad.ts`, donde puede dar un mensaje que se entiende. Acá alcanza
-- con descartar lo imposible.
ALTER TABLE "users"
  ADD CONSTRAINT "users_birth_date_check"
  CHECK (
    "birth_date" IS NULL
    OR ("birth_date" > DATE '1890-01-01' AND "birth_date" < DATE '2030-01-01')
  );

-- Para el informe de cuántas cuentas todavía no declararon. Parcial porque la
-- pregunta que se hace siempre es sobre las que faltan, no sobre las que ya la
-- tienen.
CREATE INDEX "users_sin_fecha_de_nacimiento_idx"
  ON "users" ("created_at")
  WHERE "birth_date" IS NULL AND "deleted_at" IS NULL;
