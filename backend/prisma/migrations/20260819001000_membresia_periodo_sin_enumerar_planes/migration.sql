-- La restricción que enumeraba los planes de memoria.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- QUÉ ESTABA MAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `seller_memberships_free_sin_periodo` decía:
--
--     CHECK ("plan" = 'PRO' OR "periodo" IS NULL)
--
-- La regla que quería expresar es la de su propio comentario: «Free no lleva
-- período, no se renueva nada». Pero la escribió al revés, nombrando el único
-- plan pago que existía ese día.
--
-- Con BUSINESS en el enum, otorgarle un período mensual a un Business violaba
-- la restricción:
--
--     new row for relation "seller_memberships" violates check constraint
--     "seller_memberships_free_sin_periodo"
--
-- No es teórico: lo tiró el primer test que intentó crear una membresía
-- Business. Sin esto, `otorgar()` funcionaría para Pro y fallaría para Business
-- con un error de base que no menciona planes por ningún lado — el tipo de
-- error que se debuguea mirando el lugar equivocado durante media hora.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- POR QUÉ ANCLADA EN FREE Y NO ENUMERANDO LOS PAGOS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Porque es de lo que habla la regla. `"plan" <> 'FREE'` dice «cualquier plan
-- que no sea Free puede tener período», que es exactamente la intención, y el
-- día que haya un cuarto plan no hay que acordarse de esta línea.
--
-- Es además cómo ya estaba escrita la restricción hermana:
--
--     seller_memberships_pro_vence
--     CHECK ("plan" = 'FREE' OR "vigente_hasta" IS NOT NULL)
--
-- Esa quedó bien de entrada y no se toca: sirve igual para BUSINESS.
--
-- ⚠️ La restricción nueva es MÁS PERMISIVA que la vieja: todo lo que pasaba
-- antes sigue pasando. Ninguna fila existente puede quedar en falta, así que no
-- hay datos que migrar ni nada que validar antes.
--
-- ─── Por qué es una migración aparte de la que agregó BUSINESS ───
--
-- Porque aquélla ya se aplicó. Prisma verifica las migraciones por checksum:
-- editar un archivo ya aplicado hace fallar el próximo `migrate deploy` con un
-- desajuste, y el despliegue se cae sin haber tocado nada malo. Una migración
-- aplicada es historia; lo que sigue va en una nueva.

ALTER TABLE "seller_memberships"
  DROP CONSTRAINT IF EXISTS "seller_memberships_free_sin_periodo";

ALTER TABLE "seller_memberships"
  ADD CONSTRAINT "seller_memberships_free_sin_periodo"
  CHECK ("plan" <> 'FREE' OR "periodo" IS NULL);
