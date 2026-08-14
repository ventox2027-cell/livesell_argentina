# Admin Lite

Herramienta de operación y soporte de VendoX.

**No es un tablero para mirar el negocio. Es la herramienta para resolverlo
cuando algo sale mal.**

El objetivo concreto: que ningún incidente en producción tenga que resolverse
entrando a PostgreSQL a mano.

```
BUSCAR → ENTENDER → ACTUAR → AUDITAR
```

---

## Levantarlo en local

```powershell
# 1. Backend
cd backend
npm run dev                      # http://localhost:3100

# 2. Panel
cd admin
pnpm install
pnpm dev                         # http://localhost:3200
```

Si el backend no está en `localhost:3100`, copiá `.env.example` a `.env.local`
y ajustá `NEXT_PUBLIC_API_BASE_URL`.

---

## Crear el primer administrador

**No existe `POST /admin/register` y no debe existir nunca.** Un endpoint que
otorga el rol más poderoso del sistema es un objetivo permanente, y el clásico
es dejarlo abierto "hasta crear el primer admin" y olvidarse.

El rol se otorga desde el servidor, sobre un usuario que **ya existe**:

```powershell
# 1. Que la persona entre a la app una vez (Google, Apple o modo prueba).
# 2. Desde backend/:
npm run admin:create -- persona@ejemplo.com
```

El script no crea cuentas ni contraseñas. Así no hay ninguna credencial
inventada por nosotros dando vueltas, y la identidad la verifica el proveedor.

**Jamás un `admin/admin`.**

Otorgar el rol queda auditado con actor `system`: si un día aparece un
administrador que nadie recuerda haber creado, la bitácora dice cuándo.

Quitarlo es un `UPDATE` a `buyer`, y el efecto es inmediato — el guard lee el
rol de la base en cada petición.

---

## Autorización

| | |
|---|---|
| Guard | `@Roles('admin')` a nivel de **clase** en `AdminController` |
| Origen del rol | la **base**, en cada petición — no el token |
| Sin sesión | 401 |
| Usuario común o vendedor | 403 |
| Admin suspendido | 403 en la petición siguiente |

El decorador está a nivel de clase a propósito. Con uno por método, agregar un
endpoint y olvidarse del decorador lo deja accesible a cualquier usuario
autenticado — y lo que falta es una línea que no está, así que no se ve al
revisar el código. A nivel de clase el olvido tiene el signo contrario.

El test de integración **recorre las 25 rutas** y comprueba las tres
respuestas. Al agregar un endpoint hay que agregarlo a esa lista.

---

## Endpoints

```
GET  /api/v1/admin/attention                    contadores de lo que pide acción
GET  /api/v1/admin/search?q=                    búsqueda global

GET  /api/v1/admin/users
GET  /api/v1/admin/users/:id
POST /api/v1/admin/users/:id/suspend
POST /api/v1/admin/users/:id/reactivate
POST /api/v1/admin/users/:id/revoke-sessions

GET  /api/v1/admin/sellers
GET  /api/v1/admin/sellers/:id
POST /api/v1/admin/sellers/:id/suspend
POST /api/v1/admin/sellers/:id/reactivate
POST /api/v1/admin/sellers/:id/block

GET  /api/v1/admin/products/:id
POST /api/v1/admin/products/:id/pause
POST /api/v1/admin/products/:id/reactivate

GET  /api/v1/admin/orders
GET  /api/v1/admin/orders/:id
GET  /api/v1/admin/orders/:id/timeline          ← la pantalla que importa

GET  /api/v1/admin/payments
POST /api/v1/admin/payments/:id/reconcile

GET  /api/v1/admin/refunds
POST /api/v1/admin/refunds/:id/retry

GET  /api/v1/admin/webhooks
GET  /api/v1/admin/audit
GET  /api/v1/admin/audit/:entityType/:entityId
```

Todo `POST` exige `{ "reason": "..." }` con al menos 10 caracteres.

---

## La búsqueda

Una sola caja. Quien atiende recibe un dato pegado de cualquier lado y no sabe
—ni tiene por qué— si es un `orderId`, un `paymentAttemptId` o un id de Mercado
Pago.

| Lo que escribís | Qué hace |
|---|---|
| `usr_`, `sel_`, `sto_`, `prd_`, `ord_`, `pay_`, `ref_`, `rsv_` | va derecho a esa tabla, lectura por clave primaria |
| algo con `@` | usuario por email **exacto**, con sus órdenes |
| dígitos con formato de teléfono | usuario por los últimos 8 dígitos |
| lo demás | referencia de orden, id de pago del proveedor, o nombre de producto por prefijo |

**No hay búsqueda parcial sobre datos personales.** Buscar "juan" no devuelve
todos los Juanes. Un panel que lista personas por coincidencia parcial es un
exportador de base de datos con otra interfaz; para operar hace falta encontrar
a alguien concreto del que ya se tiene un dato exacto.

El mínimo de 3 caracteres tampoco es cosmético: con uno, `LIKE '%a%'` es un
escaneo completo de tabla y un volcado de datos personales por accidente.

---

## La cronología

`/ordenes/<id>` es la pantalla que justifica el panel entero.

Cuando alguien escribe *"pagué y no me llegó"*, la respuesta está repartida en
cinco tablas y ninguna cuenta la historia completa: la orden dice
`PAYMENT_REQUIRES_REFUND`, hay dos intentos de pago con estados distintos, un
webhook llegó tarde, y hay una devolución en curso.

La cronología combina, en orden y en castellano:

- creación de la orden y reserva de stock
- cada intento de cobro, con su tarjeta y su desenlace
- consultas al proveedor
- hitos: pagada, confirmada, cancelada, vencida, devuelta
- devoluciones y sus reintentos
- webhooks de Mercado Pago, marcando los de firma inválida
- **acciones de soporte**, con su motivo

Se arma en el backend, no en React: ordenar eventos de cinco tablas requiere
conocer las reglas del dominio, y ponerlas en el frontend sería duplicarlas
donde nadie las va a mantener.

---

## Acciones

Cada una es un **comando explícito** (`/suspend`, `/block`), no un `PATCH` con
el estado libre. Con una mutación genérica el conjunto de transiciones posibles
es el producto cartesiano de todos los estados, y la mayoría no tiene sentido —
pero el endpoint las acepta igual.

### Motivo obligatorio

Mínimo 10 caracteres. No es para tener el campo lleno: es para que sirva dentro
de seis meses. Un `min(1)` se satisface con "x" y deja la bitácora tan inútil
como vacía, con la diferencia de que ahora parece completa.

Y no hay lista de motivos predefinidos. Un desplegable con "fraude / spam /
pedido del usuario" se completa más rápido y se lee mucho peor: el caso real
casi nunca encaja, y quien opera elige el que menos se aleja.

### Qué hace cada una

| Acción | Qué hace | Qué NO hace |
|---|---|---|
| Suspender usuario | bloquea el acceso **y revoca todas las sesiones** | — |
| Reactivar usuario | devuelve el acceso | no reactiva cuentas eliminadas |
| Cerrar sesiones | cierra todo sin suspender | — |
| Suspender vendedor | pausa sus tiendas | **no cancela órdenes pagadas, no borra nada** |
| Bloquear vendedor | bloqueo por fraude | **no se revierte desde el panel** |
| Reactivar vendedor | vuelve a activo | **no reabre las tiendas**: eso lo decide el vendedor |
| Pausar producto | deja de venderse | no toca órdenes existentes |
| Conciliar pago | pregunta al proveedor y aplica | no decide nada por su cuenta |
| Reintentar devolución | reintenta el monto ya determinado | **no permite elegir el importe** |

Tres decisiones que vale explicar:

**Suspender un vendedor no cancela órdenes.** Una orden pagada y confirmada es
una obligación con un comprador que no tiene nada que ver con la infracción del
vendedor. Cancelarlas automáticamente convertiría una sanción en un problema
para gente que no hizo nada.

**Conciliar usa la misma función que el worker.** Si el panel decidiera por su
cuenta qué hacer con un pago en estado desconocido, habría dos sistemas de
conciliación con dos criterios, y el día que difieran nadie sabría cuál tiene
razón.

**No hay botón "devolver dinero" con monto libre.** El monto lo determinó el
dominio al crear la devolución. Un campo editable es la forma más directa de
que un error de tipeo mande diez veces de más, o de que una cuenta comprometida
saque plata.

---

## Datos sensibles

Cada entidad tiene **una** función de vista en `admin.view.ts` que decide qué
sale. No hay `select` sueltos por veinte consultas.

La razón no es sólo mínimo privilegio: es que el día que se agregue una columna
sensible al esquema —el token de OAuth de Mercado Pago, un documento— hay que
acordarse de excluirla en cada lugar. Nadie se acuerda de todos.

| | |
|---|---|
| Email | enmascarado: `ju****@ejemplo.com` |
| Teléfono | últimos 4: `**********4455` |
| Tarjeta | marca y últimos 4 |
| PAN, CVV | **nunca existieron en esta base** (diseño SAQ-A) |
| `idempotencyKey` | no sale: se deriva del token de tarjeta |
| Cuerpo y cabeceras de webhooks | no salen |
| Dirección de envío | **sí sale completa** — es lo primero que se mira cuando un pedido no llegó |

`test/unit/admin-sin-secretos.spec.ts` le pasa a cada función de vista un objeto
contaminado con veinte campos prohibidos y falla si alguno aparece. Incluye
campos que todavía no están en el esquema: el test tiene que estar listo antes
que la columna.

---

## La bitácora

Append-only. **No hay endpoint de modificación ni de borrado, y un test lo
comprueba.**

Su único valor es que nadie —ni siquiera quien tiene la cuenta más
privilegiada— pueda cambiar lo que dice.

Cada acción registra actor, tipo de actor, acción, entidad, id, **motivo**,
antes, después, IP y user-agent. La IP sale de `ipDelCliente`, no de `req.ip`:
una bitácora con IPs falsificables es peor que una sin IPs.

---

## Métricas

```
admin_actions_total{accion="..."}
admin_refund_retries_total
admin_manual_reconciliations_total
```

La primera responde la pregunta que importa: **¿por qué de golpe se están
suspendiendo veinte vendedores por hora?** Eso puede ser una campaña legítima
contra spam o una cuenta comprometida, y en los dos casos hay que enterarse
mientras pasa.

---

## Deuda conocida

1. **El token vive en `localStorage`.** Un XSS en el panel podría leerlo. Se
   acepta porque es una herramienta interna sin contenido de terceros y el
   access token dura 15 minutos; cuando el panel salga a un dominio público,
   pasa a cookie `httpOnly`.
2. **Login sólo con el modo prueba del backend.** Google para web no está
   implementado. El botón aparece según lo que responde `/auth/config`, así que
   en producción —donde el backend prohíbe el login de desarrollo— esta pantalla
   dice que no hay forma de entrar en vez de mostrar un botón que no funciona.
3. **Sin tests de frontend.** Los de seguridad están en el backend, que es donde
   sirven. Los del panel son de interfaz y todavía no ganan su lugar.
4. **La paginación no tiene "página anterior".** El cursor va hacia adelante.
5. **Sin sección de moderación de Live** — el dominio todavía no existe y no se
   construye navegación para algo que no está.
