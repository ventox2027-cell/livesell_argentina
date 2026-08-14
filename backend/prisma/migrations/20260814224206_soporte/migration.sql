-- CreateEnum
CREATE TYPE "SupportCategory" AS ENUM ('ENVIO', 'CAMBIOS', 'PAGOS', 'DISPUTA', 'CUENTA', 'VENDEDOR', 'PROBLEMA_TECNICO', 'OTRO');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('ABIERTO', 'ESPERANDO_RESPUESTA', 'ESCALADO', 'RESUELTO', 'CERRADO');

-- CreateEnum
CREATE TYPE "SupportAuthor" AS ENUM ('USUARIO', 'ASISTENTE', 'EQUIPO', 'SISTEMA');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category" "SupportCategory" NOT NULL DEFAULT 'OTRO',
    "status" "SupportStatus" NOT NULL DEFAULT 'ABIERTO',
    "subject" TEXT NOT NULL,
    "order_id" TEXT,
    "assigned_to_user_id" TEXT,
    "escalation_reason" TEXT,
    "escalated_at" TIMESTAMP(3),
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "author" "SupportAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "author_user_id" TEXT,
    "escalated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_tickets_user_id_last_message_at_idx" ON "support_tickets"("user_id", "last_message_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_last_message_at_idx" ON "support_tickets"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "support_messages_ticket_id_created_at_idx" ON "support_messages"("ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Un mensaje vacio no es un mensaje.
--
-- Aparece en la conversacion como una burbuja en blanco que nadie entiende, y
-- del lado del equipo hace pensar que el sistema perdio algo.
ALTER TABLE "support_messages"
  ADD CONSTRAINT "soporte_mensaje_no_vacio_check"
  CHECK (length(btrim("body")) > 0);

ALTER TABLE "support_tickets"
  ADD CONSTRAINT "soporte_asunto_no_vacio_check"
  CHECK (length(btrim("subject")) > 0);

-- Escalado implica motivo y fecha.
--
-- Un ticket escalado sin motivo llega a la bandeja del equipo sin decir por
-- que la maquina no pudo resolverlo, que es justo lo que hace falta para
-- atenderlo rapido.
ALTER TABLE "support_tickets"
  ADD CONSTRAINT "soporte_escalado_con_motivo_check"
  CHECK (
    "status" <> 'ESCALADO'
    OR ("escalation_reason" IS NOT NULL AND "escalated_at" IS NOT NULL)
  );
