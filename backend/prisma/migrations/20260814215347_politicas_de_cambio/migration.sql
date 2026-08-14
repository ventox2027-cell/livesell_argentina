-- CreateEnum
CREATE TYPE "ExchangeMode" AS ENUM ('SOLO_LEGAL', 'CAMBIO_SIN_CAUSA', 'DEVOLUCION_SIN_CAUSA');

-- CreateEnum
CREATE TYPE "ReturnShippingPayer" AS ENUM ('VENDEDOR', 'COMPRADOR');

-- AlterTable
ALTER TABLE "stores" ADD COLUMN     "exchange_mode" "ExchangeMode" NOT NULL DEFAULT 'SOLO_LEGAL',
ADD COLUMN     "exchange_note" TEXT,
ADD COLUMN     "exchange_window_days" SMALLINT NOT NULL DEFAULT 10,
ADD COLUMN     "return_shipping_paid_by" "ReturnShippingPayer" NOT NULL DEFAULT 'VENDEDOR';

-- Ultima linea de defensa del piso legal.
--
-- Diez dias corridos de arrepentimiento, ley 24.240 art. 34 y art. 1110 del
-- Codigo Civil y Comercial. El vendedor puede ofrecer mas; menos, no.
--
-- El CHECK esta aca ademas de en el codigo porque una clausula nula publicada
-- como si valiera nos hace responsables a nosotros tambien, y ese riesgo no
-- puede depender de que nadie escriba un UPDATE a mano.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_piso_legal_arrepentimiento_check"
  CHECK ("exchange_window_days" >= 10 AND "exchange_window_days" <= 365);

-- El arrepentimiento es "sin costo alguno" para el comprador.
--
-- Un vendedor que solo cumple el minimo legal no puede declarar que el envio
-- de vuelta lo paga la otra persona: eso convierte el derecho en algo que
-- cuesta plata ejercer. Si ofrece MAS que el minimo, ahi si puede.
ALTER TABLE "stores"
  ADD CONSTRAINT "stores_envio_de_vuelta_coherente_check"
  CHECK ("exchange_mode" <> 'SOLO_LEGAL' OR "return_shipping_paid_by" = 'VENDEDOR');
