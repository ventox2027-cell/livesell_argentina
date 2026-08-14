-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "pickup_selected" BOOLEAN NOT NULL DEFAULT false;

-- Ultima linea de defensa: si la persona retira, no se le cobra envio.
--
-- El calculo ya lo garantiza (`costoDeEnvio` devuelve 0 cuando retira), pero
-- eso es una funcion que alguien puede tocar. Esto es la base diciendo que no.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_pickup_sin_envio_check"
  CHECK (NOT "pickup_selected" OR "shipping_amount" = 0);
