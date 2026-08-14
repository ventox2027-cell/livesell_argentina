-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('STORE_REOPENED', 'LIVE_STARTED', 'ORDER_STATUS', 'ORDER_RECEIVED', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED', 'SUPPORT_REPLY', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "NotificationPushStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMP(3),
    "push_status" "NotificationPushStatus" NOT NULL DEFAULT 'PENDING',
    "push_attempts" SMALLINT NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "pushed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_push_status_next_attempt_at_idx" ON "notifications"("push_status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- El texto de un aviso no puede estar vacio.
--
-- Una notificacion sin titulo aparece en el centro como una fila en blanco que
-- no se puede tocar ni entender. Es mejor que falle el INSERT y se vea en los
-- logs que dejar basura que el usuario descubre.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_texto_no_vacio_check"
  CHECK (length(btrim("title")) > 0 AND length(btrim("body")) > 0);

-- Los intentos de envio no pueden ser negativos ni dispararse.
--
-- El tope de 20 es la senal de que algo esta reintentando en bucle: FCM da por
-- muerto un token mucho antes.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_intentos_check"
  CHECK ("push_attempts" >= 0 AND "push_attempts" <= 20);
