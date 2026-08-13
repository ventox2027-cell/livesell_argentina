-- CreateEnum
CREATE TYPE "pay_order_status" AS ENUM ('PENDING_PAYMENT', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "pay_payment_status" AS ENUM ('PENDING', 'IN_PROCESS', 'AUTHORIZED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REFUNDED', 'CHARGED_BACK', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "pay_source" AS ENUM ('API', 'WEBHOOK', 'RECONCILER', 'MANUAL');

-- CreateTable
CREATE TABLE "spike_orders" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "buyer_email" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "status" "pay_order_status" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "spike_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "mp_payment_id" TEXT,
    "status" "pay_payment_status" NOT NULL DEFAULT 'PENDING',
    "status_detail" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "installments" INTEGER NOT NULL DEFAULT 1,
    "payment_method_id" TEXT,
    "payment_type_id" TEXT,
    "card_last_four" TEXT,
    "card_brand" TEXT,
    "raw_response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spike_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_payment_events" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "source" "pay_source" NOT NULL,
    "kind" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spike_payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mp_webhook_events" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "action" TEXT,
    "resource_id" TEXT,
    "signature_valid" BOOLEAN NOT NULL,
    "rejection_reason" TEXT,
    "headers" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mp_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_customers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mp_customer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spike_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spike_customer_cards" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "mp_card_id" TEXT NOT NULL,
    "last_four" TEXT NOT NULL,
    "brand" TEXT,
    "expiration_month" INTEGER,
    "expiration_year" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spike_customer_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spike_orders_idempotency_key_key" ON "spike_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "spike_orders_status_created_at_idx" ON "spike_orders"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "spike_payments_mp_payment_id_key" ON "spike_payments"("mp_payment_id");

-- CreateIndex
CREATE INDEX "spike_payments_order_id_created_at_idx" ON "spike_payments"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "spike_payments_status_idx" ON "spike_payments"("status");

-- CreateIndex
CREATE INDEX "spike_payment_events_order_id_at_idx" ON "spike_payment_events"("order_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "mp_webhook_events_notification_id_key" ON "mp_webhook_events"("notification_id");

-- CreateIndex
CREATE INDEX "mp_webhook_events_resource_id_received_at_idx" ON "mp_webhook_events"("resource_id", "received_at");

-- CreateIndex
CREATE INDEX "mp_webhook_events_signature_valid_received_at_idx" ON "mp_webhook_events"("signature_valid", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "spike_customers_email_key" ON "spike_customers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "spike_customers_mp_customer_id_key" ON "spike_customers"("mp_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "spike_customer_cards_mp_card_id_key" ON "spike_customer_cards"("mp_card_id");

-- CreateIndex
CREATE INDEX "spike_customer_cards_customer_id_idx" ON "spike_customer_cards"("customer_id");

-- AddForeignKey
ALTER TABLE "spike_payments" ADD CONSTRAINT "spike_payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "spike_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spike_payment_events" ADD CONSTRAINT "spike_payment_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "spike_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spike_customer_cards" ADD CONSTRAINT "spike_customer_cards_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "spike_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
