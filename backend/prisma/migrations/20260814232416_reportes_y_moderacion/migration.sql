-- CreateEnum
CREATE TYPE "ReportTarget" AS ENUM ('PRODUCT', 'LIVE', 'SELLER', 'REVIEW', 'CHAT_MESSAGE');

-- CreateEnum
CREATE TYPE "ReportReason" AS ENUM ('PROHIBIDO', 'FALSIFICADO', 'CONTENIDO_AJENO', 'CONTENIDO_SEXUAL', 'VIOLENCIA', 'ESTAFA', 'ENGANOSO', 'SPAM', 'OTRO');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDIENTE', 'CONFIRMADO', 'DESESTIMADO', 'DUPLICADO');

-- AlterTable
--
-- ⚠️ Prisma agregaba acá un `ALTER COLUMN "search_vector" DROP DEFAULT` que se
-- borró a mano: esa columna es GENERADA y esa sentencia falla. Prisma lee la
-- expresión de la columna generada como si fuera un default y la va a proponer
-- en TODAS las migraciones futuras. Ver el comentario en el schema.
ALTER TABLE "products" ADD COLUMN "hidden_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "reporter_user_id" TEXT,
    "target_type" "ReportTarget" NOT NULL,
    "target_id" TEXT NOT NULL,
    "reason" "ReportReason" NOT NULL,
    "detail" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDIENTE',
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moderation_actions" (
    "id" TEXT NOT NULL,
    "target_type" "ReportTarget" NOT NULL,
    "target_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "reason" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reports_status_created_at_idx" ON "reports"("status", "created_at");

-- CreateIndex
CREATE INDEX "reports_target_type_target_id_status_idx" ON "reports"("target_type", "target_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reports_reporter_user_id_target_type_target_id_key" ON "reports"("reporter_user_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "moderation_actions_target_type_target_id_created_at_idx" ON "moderation_actions"("target_type", "target_id", "created_at");

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Una decision de moderacion SIN motivo no se puede defender ni revisar.
--
-- Cuando el vendedor reclame, lo unico que hay para mirar es esta columna.
ALTER TABLE "moderation_actions"
  ADD CONSTRAINT "moderacion_con_motivo_check"
  CHECK (length(btrim("reason")) > 0);

-- Resolver un reporte exige decir por que.
ALTER TABLE "reports"
  ADD CONSTRAINT "reporte_resuelto_con_motivo_check"
  CHECK (
    "status" = 'PENDIENTE'
    OR ("resolution" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  );
