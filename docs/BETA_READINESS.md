# ¿Está lista para la beta?

Estado al 15 de agosto de 2026.

**Sí para una beta cerrada. No para Google Play todavía**, y lo que falta para
eso no es código: son cuatro cosas que sólo puede hacer una persona con acceso a
las cuentas. Están en [`PRODUCTION_GAPS.md`](PRODUCTION_GAPS.md).

---

## En una línea

Se puede abrir una tienda, cargar productos, transmitir en vivo, comprar
mientras se mira, pagar con Mercado Pago, seguir el pedido y confirmarlo con un
código de seis dígitos. Todo eso funciona de punta a punta contra una base real
y está sostenido por 1286 tests de backend y 242 de la app.

---

## Lo que funciona

| Área | Estado |
|---|---|
| Entrar con Google | ✅ |
| Abrir tienda, cargar productos con variantes y fotos | ✅ |
| Stock y reservas — sobreventa imposible por construcción | ✅ |
| Transmitir en vivo con LiveKit | ✅ |
| Chat del vivo, con antiflood y filtro | ✅ |
| Comprar durante el vivo | ✅ |
| Cobrar con Mercado Pago, a la cuenta del vendedor | ✅ |
| Envío, retiro en persona y devoluciones | ✅ |
| Entrega con código de seis dígitos | ✅ |
| Bloquear personas, reportar, moderar el chat | ✅ |
| Panel de administración | ✅ |
| Descargar los propios datos y cerrar la cuenta | ✅ |
| Notificaciones push | ⚠️ el backend está entero, **la app no registra el token** |
| Iniciar sesión con Apple | ⚠️ backend listo, botón deshabilitado hasta tener cuenta de desarrollador |
| Reportar una reseña | ⚠️ el backend lo soporta, no hay pantalla que las liste |

---

## Lo que garantiza el sistema

Veinte reglas, cada una como un test que se ejecuta:
[`invariantes.spec.ts`](../backend/test/integration/invariantes.spec.ts).

Las cinco que más importan:

1. **La comisión es 6 % y sólo sobre el producto.** No sobre el envío.
2. **Nunca hay dos ventas para la misma unidad.** Un UPDATE condicional atómico
   más un CHECK en la base. Verificado con veinte compras concurrentes.
3. **La plata del comprador nunca entra a la cuenta de VendoX.** Un vendedor sin
   Mercado Pago conectado no puede publicar, ni transmitir, ni cobrar.
4. **Un recurso ajeno responde 404, nunca 403.** La pertenencia va en el WHERE
   de la consulta, no en un `if` posterior que alguien pueda olvidarse de
   escribir.
5. **Ningún reporte sanciona una cuenta por sí solo.**

No es una lista de intenciones: si alguna deja de valer, el build se rompe.

---

## Cómo está probado

| Qué | Cuánto |
|---|---|
| Tests de backend | **1286**, contra PostgreSQL y Redis reales |
| Tests de la app | **242** |
| Archivos de test | 57 |
| Lint, typecheck y analyze | limpios en las tres bases de código |

**Mercado Pago es lo único falso.** Hace falta poder decir «este cobro se
aprueba», «este se rechaza» y —lo más importante— «de este no vamos a saber
nunca el resultado». Contra Mercado Pago real esos escenarios no se pueden
provocar a voluntad, y son justo los que rompen sistemas. Todo lo demás es real:
las transiciones, los índices únicos, los CHECK y la concurrencia de PostgreSQL.

### Verificación por sabotaje

Cada regla importante se rompió a propósito para confirmar que algún test la
ve. Un test que pasa no prueba nada hasta que se lo ve fallar.

| Sabotaje | Resultado |
|---|---|
| Comisión sobre el total en vez del producto | falla el invariante 1 |
| El WHERE de la reserva no compara la cantidad | **no falla**, lo ataja el CHECK de la base |
| Ese WHERE roto **más** el CHECK borrado | falla el invariante 6 |
| Quitar `buyerId` del WHERE de la orden | falla el invariante 14 |
| Anular la exigencia de Mercado Pago | 4 tests |
| Guardar el código de entrega en claro | 8 tests |
| Anular la mayoría de edad | 5 tests |
| Corte de chat unidireccional | 7 tests |
| Filtro de chat que no frena + borrado físico | 3 tests |
| Ungatear la UI de desarrollo | 3 tests |

El segundo caso es el más interesante: el sistema aguanta con una de las dos
capas rota. Para eso existe la segunda.

---

## Lo que la beta va a poner a prueba y los tests no

Honestidad sobre los límites de todo lo de arriba.

- **La latencia real del vivo con gente de verdad.** Está medida en la prueba de
  campo del Sprint 0, no con cincuenta personas mirando a la vez.
- **Mercado Pago en producción.** Los tests usan un proveedor falso. Los códigos
  de rechazo reales, los tiempos reales y los webhooks que llegan tarde de
  verdad sólo aparecen cobrando.
- **Qué hace la gente que no esperamos.** Ningún test cubre a alguien que
  entiende mal la pantalla.
- **4G argentino de verdad.** El reconectar está probado; la variedad de redes
  móviles reales, no.

---

## Antes de abrir la beta

- [ ] Correr la cuenta de revisión:
      `REVIEW_ACCOUNT_PASSWORD='…' node scripts/cuenta-de-revision.mjs`
- [ ] `DEMO_LOGIN_ENABLED=true` en el servidor de la beta
- [ ] Credenciales **de prueba** de Mercado Pago cargadas
- [ ] `privacidad@vendox.com.ar` creado y con alguien que lo lea
- [ ] Publicar `/privacidad` y `/eliminar-cuenta` — ver [`web/README.md`](../web/README.md)
- [ ] Verificar que las cuatro banderas de emergencia estén encendidas
- [ ] Tener a mano cómo apagarlas: es lo primero que se hace si algo sale mal

---

## Documentos relacionados

- [`PRODUCTION_GAPS.md`](PRODUCTION_GAPS.md) — lo que falta y por qué
- [`POLITICA-UGC.md`](POLITICA-UGC.md) — qué modera VendoX y qué decide una persona
- [`PRIVACIDAD-AUDITORIA.md`](PRIVACIDAD-AUDITORIA.md) — inventario de datos, campo por campo
- [`SEGURIDAD-DE-ENTORNO.md`](SEGURIDAD-DE-ENTORNO.md) — qué no viaja en la APK
- [`CUENTA-DE-REVISION.md`](CUENTA-DE-REVISION.md) — la cuenta para Google Play
