-- Reportar a una persona, no sólo a lo que publicó.
--
-- Faltaba el destino `USER`. Se podía reportar un producto, un vivo, una
-- tienda, una reseña o un mensaje, pero no a alguien por su comportamiento
-- sostenido —que es el caso del acoso, donde ningún mensaje suelto alcanza
-- para explicar el problema—.
--
-- ⚠️ `USER` apunta al id de la CUENTA, no al del vendedor. Un comprador que
-- acosa en el chat no tiene perfil de vendedor, y sin este destino no había
-- forma de reportarlo.

ALTER TYPE "ReportTarget" ADD VALUE IF NOT EXISTS 'USER';
