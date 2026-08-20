-- Si la vidriera pública de la tienda se puede navegar.
--
-- Aditiva y con default: las tiendas que ya existen quedan con la vidriera
-- encendida, que es como se comportaban hasta ahora. No toca ninguna fila
-- existente más que para completar el default, y no depende de ninguna otra
-- columna.
--
-- NO se reutilizó `status` ni el horario ni la pausa de compras: responden
-- preguntas distintas. Ver el comentario del campo en `schema.prisma`.
ALTER TABLE "stores" ADD COLUMN "storefront_enabled" BOOLEAN NOT NULL DEFAULT true;
