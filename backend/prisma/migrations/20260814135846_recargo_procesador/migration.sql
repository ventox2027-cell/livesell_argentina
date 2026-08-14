-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "processor_surcharge_amount" INTEGER NOT NULL DEFAULT 0;

-- El recargo no puede ser negativo: sería un descuento disfrazado, cobrado por
-- un concepto que dice lo contrario.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_processor_surcharge_check"
  CHECK ("processor_surcharge_amount" >= 0);
