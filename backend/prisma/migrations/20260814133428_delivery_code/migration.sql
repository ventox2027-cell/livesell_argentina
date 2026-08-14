-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "delivery_code" TEXT,
ADD COLUMN     "delivery_code_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "delivery_code_issued_at" TIMESTAMP(3),
ADD COLUMN     "delivery_code_locked_until" TIMESTAMP(3),
ADD COLUMN     "preparing_at" TIMESTAMP(3),
ADD COLUMN     "ready_at" TIMESTAMP(3),
ADD COLUMN     "shipped_at" TIMESTAMP(3);

-- El contador de intentos no puede ser negativo ni crecer sin límite por un
-- error de código. Es la última línea de defensa: si algún día alguien escribe
-- un decremento mal, la base lo frena en vez de dejar un pedido inconfirmable.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delivery_code_attempts_check"
  CHECK ("delivery_code_attempts" >= 0 AND "delivery_code_attempts" <= 50);

-- El código es de seis dígitos. Se valida también acá porque es el dato que
-- decide si un pedido se marca entregado.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delivery_code_format_check"
  CHECK ("delivery_code" IS NULL OR "delivery_code" ~ '^[0-9]{6}$');

-- Buscar por código es la operación del vendedor confirmando la entrega.
CREATE INDEX "orders_delivery_pending_idx"
  ON "orders" ("seller_id", "status")
  WHERE "delivery_code" IS NOT NULL AND "delivered_at" IS NULL;
