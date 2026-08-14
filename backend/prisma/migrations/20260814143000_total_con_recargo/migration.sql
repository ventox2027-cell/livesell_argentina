-- El total ahora tiene cuatro partes, no tres.
--
-- `orden_total_coherente` se escribió cuando el total era producto + envío -
-- descuento. Con el recargo del procesador trasladado al comprador hay una
-- cuarta, y la restriccion vieja rechaza toda orden de una tienda que lo
-- traslade: el INSERT falla con el nombre de una restriccion y nadie entiende
-- por que no se puede comprar en esa tienda.
--
-- Se reemplaza en vez de agregar otra: dos CHECK sobre el mismo total, uno
-- viejo y uno nuevo, es la forma mas rapida de que dentro de un ano nadie sepa
-- cual manda.
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orden_total_coherente";

ALTER TABLE "orders"
  ADD CONSTRAINT "orden_total_coherente"
  CHECK (
    "gross_amount" =
      "items_subtotal" + "shipping_amount" + "processor_surcharge_amount" - "discount_amount"
  );
