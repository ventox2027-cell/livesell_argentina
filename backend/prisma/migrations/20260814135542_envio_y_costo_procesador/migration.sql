-- CreateEnum
CREATE TYPE "shipping_mode" AS ENUM ('FREE', 'FIXED_PRICE', 'PICKUP_ONLY', 'FIXED_OR_PICKUP');

-- CreateEnum
CREATE TYPE "processor_fee_mode" AS ENUM ('ABSORBED', 'PASSED_TO_BUYER');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "processor_fee_mode_snapshot" "processor_fee_mode",
ADD COLUMN     "shipping_mode_snapshot" "shipping_mode";

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "processor_fee_mode" "processor_fee_mode" NOT NULL DEFAULT 'ABSORBED',
ADD COLUMN     "shipping_flat_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_mode" "shipping_mode" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "shipping_note" TEXT;

-- El costo de envío no puede ser negativo ni absurdo. Un valor mal cargado se
-- le cobra a una persona real, así que la base lo frena.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_shipping_flat_amount_check"
  CHECK ("shipping_flat_amount" >= 0 AND "shipping_flat_amount" <= 100000000);

-- Cobrar envío exige un monto; regalarlo exige que no haya monto que cobrar.
-- Sin esto, una tienda en FIXED_PRICE con cero cobraría "envío" de $0 y el
-- comprador vería una línea que no significa nada.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_shipping_coherente_check"
  CHECK (
    ("shipping_mode" IN ('FIXED_PRICE', 'FIXED_OR_PICKUP') AND "shipping_flat_amount" > 0)
    OR ("shipping_mode" IN ('FREE', 'PICKUP_ONLY') AND "shipping_flat_amount" = 0)
  );
