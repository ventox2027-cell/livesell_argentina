-- La cuenta de demostración para la revisión de Google Play.
--
-- VendoX no tiene registro con contraseña: se entra con Google o con Apple.
-- Quien revisa la app en Google Play necesita credenciales tipeables y no puede
-- depender de una cuenta de Google real —2FA, verificaciones por país, y que la
-- cuenta sea de una persona concreta del equipo—.
--
-- `is_demo_account` es lo ÚNICO que habilita el login con contraseña.
-- `POST /auth/demo` filtra por esa columna en el WHERE: una cuenta sin la marca
-- no se puede autenticar por ahí ni con la contraseña correcta, porque la
-- consulta directamente no la encuentra.

ALTER TABLE "users"
  ADD COLUMN "is_demo_account" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "password_hash" TEXT;

-- Última línea de defensa: no puede haber un hash de contraseña en una cuenta
-- que no sea de demostración.
--
-- Si un día alguien escribe código que guarda contraseñas de usuarios reales
-- —o que copia una fila de demo a una cuenta normal— la base lo frena. Sin
-- esto, el WHERE del login sería la única barrera, y una barrera sola es una
-- barrera que alguien saltea.
ALTER TABLE "users"
  ADD CONSTRAINT "users_password_only_for_demo_check"
  CHECK ("password_hash" IS NULL OR "is_demo_account" = true);

-- El login de demostración busca por email Y por la marca. Son poquísimas filas
-- —una— así que el índice es parcial: no tiene sentido indexar 200.000 cuentas
-- normales para encontrar la única que tiene la marca.
CREATE INDEX "users_demo_idx" ON "users" ("email") WHERE "is_demo_account" = true;
