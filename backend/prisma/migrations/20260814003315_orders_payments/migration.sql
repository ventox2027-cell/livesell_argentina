-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PROCESSING_PAYMENT', 'PAID', 'CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'PAYMENT_REQUIRES_REFUND', 'REFUND_PENDING', 'REFUNDED', 'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'PROCESSING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'UNKNOWN_PENDING_RECONCILIATION');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('MERCADO_PAGO');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SellerPaymentAccountStatus" AS ENUM ('NOT_CONNECTED', 'CONNECTED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "buyer_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "reservation_id" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "items_subtotal" INTEGER NOT NULL,
    "shipping_amount" INTEGER NOT NULL DEFAULT 0,
    "discount_amount" INTEGER NOT NULL DEFAULT 0,
    "gross_amount" INTEGER NOT NULL,
    "platform_fee_bps" INTEGER NOT NULL,
    "platform_fee_amount" INTEGER NOT NULL,
    "payment_processor_fee_amount" INTEGER,
    "seller_net_amount" INTEGER NOT NULL,
    "shipping_address" JSONB NOT NULL,
    "buyer_snapshot" JSONB NOT NULL,
    "status_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "product_variant_id" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "variant_label_snapshot" TEXT NOT NULL,
    "sku_snapshot" TEXT,
    "image_url_snapshot" TEXT,
    "quantity" INTEGER NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADO_PAGO',
    "provider_payment_id" TEXT,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "idempotency_key" TEXT NOT NULL,
    "payment_method_type" TEXT,
    "brand" TEXT,
    "last_four" TEXT,
    "failure_code" TEXT,
    "failure_message_safe" TEXT,
    "processor_fee_amount" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),
    "last_checked_at" TIMESTAMP(3),

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_attempt_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADO_PAGO',
    "provider_refund_id" TEXT,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "failure_message_safe" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_addresses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "recipient_full_name" TEXT NOT NULL,
    "document_type" TEXT NOT NULL DEFAULT 'DNI',
    "document_number" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "floor" TEXT,
    "apartment" TEXT,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "postal_code" TEXT NOT NULL,
    "references" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seller_payment_accounts" (
    "id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL DEFAULT 'MERCADO_PAGO',
    "provider_account_id" TEXT,
    "status" "SellerPaymentAccountStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
    "credential_ref" TEXT,
    "scopes" TEXT,
    "expires_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seller_payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_reference_key" ON "orders"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "orders_reservation_id_key" ON "orders"("reservation_id");

-- CreateIndex
CREATE INDEX "orders_buyer_id_created_at_idx" ON "orders"("buyer_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_seller_id_status_created_at_idx" ON "orders"("seller_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_store_id_created_at_idx" ON "orders"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_created_at_idx" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_product_variant_id_idx" ON "order_items"("product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_provider_payment_id_key" ON "payment_attempts"("provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_idempotency_key_key" ON "payment_attempts"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_attempts_order_id_created_at_idx" ON "payment_attempts"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_attempts_status_last_checked_at_idx" ON "payment_attempts"("status", "last_checked_at");

-- CreateIndex
CREATE INDEX "refunds_status_created_at_idx" ON "refunds"("status", "created_at");

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "user_addresses_user_id_deleted_at_idx" ON "user_addresses"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "seller_payment_accounts_seller_id_provider_key" ON "seller_payment_accounts"("seller_id", "provider");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_addresses" ADD CONSTRAINT "user_addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seller_payment_accounts" ADD CONSTRAINT "seller_payment_accounts_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "sellers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE PRISMA NO SABE EXPRESAR
--
-- Igual que en inventario: estas restricciones son la última línea de defensa.
-- El código puede tener un bug; esto hace que el bug se manifieste como una
-- transacción rechazada y no como una orden con números imposibles.
--
-- En dinero, un número imposible que se guarda no se nota hasta que alguien
-- concilia contra el extracto bancario, meses después.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Ningún importe puede ser negativo ───

ALTER TABLE "orders"
  ADD CONSTRAINT "orden_importes_no_negativos"
  CHECK (
    "items_subtotal" >= 0
    AND "shipping_amount" >= 0
    AND "discount_amount" >= 0
    AND "gross_amount" >= 0
    AND "platform_fee_amount" >= 0
    AND ("payment_processor_fee_amount" IS NULL OR "payment_processor_fee_amount" >= 0)
  );

-- ─── El total tiene que cerrar ───
--
-- La aritmética del total vive en `pricing.ts` y está cubierta por tests. Esto
-- existe por si alguien escribe un UPDATE a mano, o por si un camino futuro
-- actualiza un componente y se olvida de recalcular el resto.
--
-- Una orden cuyo total no coincide con sus partes es un problema contable que
-- nadie descubre mirando la pantalla.
ALTER TABLE "orders"
  ADD CONSTRAINT "orden_total_coherente"
  CHECK ("gross_amount" = "items_subtotal" + "shipping_amount" - "discount_amount");

-- ─── El descuento no puede superar lo que se compró ───
ALTER TABLE "orders"
  ADD CONSTRAINT "orden_descuento_acotado"
  CHECK ("discount_amount" <= "items_subtotal" + "shipping_amount");

-- ─── La comisión, entre 0 % y 50 % ───
--
-- El techo no es una regla de negocio: es un cortafuegos. Un `platform_fee_bps`
-- mal calculado que quede en 60000 (600 %) dejaría al vendedor debiendo plata,
-- y el error recién se vería al liquidar.
ALTER TABLE "orders"
  ADD CONSTRAINT "orden_comision_razonable"
  CHECK ("platform_fee_bps" >= 0 AND "platform_fee_bps" <= 5000);

-- ─── La comisión no puede superar lo cobrado ───
ALTER TABLE "orders"
  ADD CONSTRAINT "orden_comision_no_supera_bruto"
  CHECK ("platform_fee_amount" <= "gross_amount");

-- ─── Coherencia entre estado y marcas de tiempo ───
--
-- Una orden CONFIRMED sin `confirmed_at` es una fila que la auditoría no puede
-- explicar. Y `confirmed_at` sin `paid_at` sería una venta confirmada que
-- nunca se cobró.
ALTER TABLE "orders"
  ADD CONSTRAINT "orden_marcas_de_tiempo_coherentes"
  CHECK (
    ("status" <> 'CONFIRMED' OR ("confirmed_at" IS NOT NULL AND "paid_at" IS NOT NULL))
    AND ("status" <> 'PAID' OR "paid_at" IS NOT NULL)
    AND ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL)
    AND ("status" <> 'EXPIRED' OR "expired_at" IS NOT NULL)
    AND ("status" <> 'REFUNDED' OR "refunded_at" IS NOT NULL)
  );

-- ─── Líneas de la orden ───

ALTER TABLE "order_items"
  ADD CONSTRAINT "item_cantidad_positiva"
  CHECK ("quantity" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "item_importes_no_negativos"
  CHECK ("unit_price" >= 0 AND "subtotal" >= 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "item_subtotal_coherente"
  CHECK ("subtotal" = "unit_price" * "quantity");

-- ─── Intentos de cobro ───

ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "intento_importe_positivo"
  CHECK ("amount" > 0);

-- Un intento aprobado tiene que tener su fecha y su id en el proveedor.
--
-- Sin el id no hay forma de conciliar ni de devolver la plata: sería un cobro
-- aprobado que no se puede rastrear.
ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "intento_aprobado_completo"
  CHECK (
    "status" <> 'APPROVED'
    OR ("approved_at" IS NOT NULL AND "provider_payment_id" IS NOT NULL)
  );

-- ─── Un solo intento en vuelo por orden ───
--
-- Índice único PARCIAL sobre los estados no terminales.
--
-- Es lo que impide cobrar dos veces por un doble toque en "Pagar": mientras
-- haya un cobro del que no se conoce el resultado, no se puede lanzar otro.
-- El código además lo comprueba, pero si ese camino falla, la base lo impide.
--
-- `UNKNOWN_PENDING_RECONCILIATION` entra en el índice a propósito: es
-- exactamente el estado donde MÁS peligroso sería reintentar, porque el primer
-- cobro pudo haberse procesado.
CREATE UNIQUE INDEX "intento_en_vuelo_unico_por_orden"
  ON "payment_attempts" ("order_id")
  WHERE "status" IN ('CREATED', 'PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION');

-- ─── El barrido del conciliador ───
--
-- Índice parcial: sólo los intentos sin resolver. Los aprobados y rechazados
-- se acumulan para siempre y no se consultan nunca en este camino.
CREATE INDEX "intentos_sin_resolver"
  ON "payment_attempts" ("last_checked_at")
  WHERE "status" IN ('PROCESSING', 'UNKNOWN_PENDING_RECONCILIATION');

-- ─── Devoluciones ───

ALTER TABLE "refunds"
  ADD CONSTRAINT "devolucion_importe_positivo"
  CHECK ("amount" > 0);

ALTER TABLE "refunds"
  ADD CONSTRAINT "devolucion_completada_con_fecha"
  CHECK ("status" <> 'COMPLETED' OR "completed_at" IS NOT NULL);

-- Una sola devolución viva por intento de cobro.
--
-- Sin esto, dos ejecuciones del conciliador sobre el mismo intento podrían
-- lanzar dos devoluciones y devolver la plata dos veces.
CREATE UNIQUE INDEX "devolucion_viva_unica_por_intento"
  ON "refunds" ("payment_attempt_id")
  WHERE "status" IN ('PENDING', 'PROCESSING', 'COMPLETED');

-- ─── Direcciones ───

-- Una sola dirección principal por persona.
--
-- Parcial sobre las no borradas: una dirección vieja marcada como principal no
-- tiene que bloquear a la nueva.
CREATE UNIQUE INDEX "direccion_principal_unica_por_usuario"
  ON "user_addresses" ("user_id")
  WHERE "is_default" = true AND "deleted_at" IS NULL;
