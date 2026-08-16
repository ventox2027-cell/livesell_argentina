# PRE-PRODUCTION NIGHT AUDIT

**VendoX · 13–16 de agosto de 2026 · feature freeze**

Auditoría autónoma de preproducción. Nueve secciones, sin features nuevas.

Método: **nada se da por bueno leyéndolo**. Cada afirmación de seguridad se
verificó rompiendo el código a propósito y mirando si algún test fallaba. Los
que no fallaron son los hallazgos que siguen.

---

## 0. Resumen en cuatro líneas

| | |
|---|---|
| **Bugs reales corregidos** | 5 (2 de privacidad, 1 de moderación, 2 de dinero) |
| **Falsos positivos cerrados** | 5 sabotajes que no rompían nada, ahora sí |
| **Tests** | backend **1 629** (desde 1 613) · Flutter **337** (desde 331) |
| **Estado** | Feature freeze **intacto**. Nada nuevo, nada de UX, nada de navegación. |

Ningún bug encontrado obliga a recalcular plata ya cobrada ni a notificar a
nadie. Dos de privacidad sí habrían obligado si la app hubiera estado en
producción — el detalle está en §4.

---

## 1. Auditoría de release

| CHECK | ESTADO | RIESGO | ACCIÓN NECESARIA |
|---|---|---|---|
| `applicationId` | ✅ `com.vendox.app` | — | Ninguna |
| versionCode / versionName | ✅ `1` / `0.1.0` | — | Subir antes de cada envío a Play |
| minSdk / targetSdk / compileSdk | ✅ 23 / Flutter default / 36 | — | `compileSdk 36` fijo lo exige `flutter_webrtc` |
| `debuggable` en release | ✅ ausente | — | Ninguna |
| Tráfico en claro | ✅ sólo debug/profile, y sólo a `10.0.2.2`, `127.0.0.1`, `localhost` | — | Ninguna |
| Componentes exportados | ✅ 3, todos de SDK (`FlutterFirebaseMessagingReceiver`, `RevocationBoundService`, `FirebaseInstanceIdReceiver`) | — | Ninguna |
| `allowBackup` | ✅ `false` **(corregido esta noche)** | — | Ver §4 |
| `dataExtractionRules` | ✅ `reglas_de_extraccion.xml` **(nuevo)** | — | Ver §4 |
| Cámara / micrófono | ✅ `uses-feature required="false"` | — | El PERMISO sigue declarado: se usa en LIVE |
| Tipografía | ✅ 6 TTF de Inter empaquetadas, cero `fonts.gstatic.com` en el binario | — | Ninguna |
| Firma de release | ✅ lee `key.properties`, cae a debug si no está | 🟡 | Falta generar la clave de subida |
| App Links | ✅ `autoVerify`, host `vendox.com.ar`, sin `pathPrefix` | 🔴 | **Depende del dominio.** Ver §9 |
| `assetlinks.json` | ✅ sirve DOS huellas (Play + subida) | 🔴 | Falta `ANDROID_CERT_SHA256` en producción |
| Bluetooth | 🟡 `uses-feature` **implícito y requerido** | 🟡 | Lo agrega el permiso `BLUETOOTH_CONNECT`, no el manifiesto. Ver §4 |
| Escaneo de secretos en el APK | ✅ limpio, 0 coincidencias | — | Repetir en cada build firmada |
| URL del backend | 🟡 se configura en runtime, sin valor de producción | 🔴 | Definir `--dart-define` de producción |
| Google Sign-In | 🟡 configuración correcta en el repo | 🟡 | **Sólo se prueba en build firmada en dispositivo real** |

Leyenda: 🔴 bloquea el lanzamiento · 🟡 hay que resolverlo pero no bloquea el
armado del binario.

---

## 2. Bugs reales encontrados y corregidos

### P1 · Privacidad — cerrar la cuenta dejaba la tienda publicada
`cabcc54`

Cerrar la cuenta anonimizaba `User` y vaciaba las direcciones. Pero el perfil
de vendedor es **otra fila**, con su propio `displayName`, su `bio` y su
`avatarUrl` —que casi siempre es una foto de la persona—. Las consultas
públicas filtran por `seller.status = 'ACTIVE'` y nada ponía ese estado en otra
cosa.

Alguien ejercía su derecho a que lo borren y su nombre y su cara seguían online
en `vendox.com.ar`, con los productos a la venta.

Lo delata como olvido y no como decisión: el enum `SellerStatus` ya tenía
`CLOSED` — «cerrado por decisión propia» — sin que nadie lo escribiera nunca.

**Corregido con** 2 tests + 3 sabotajes (cada parte del arreglo falla por
separado).

### P1 · Moderación — sancionar no le cortaba la transmisión
`5e42d8b`

`cambiarEstadoVendedor` pausa las tiendas del sancionado. `activos()` —el feed
de vivos— no miraba su estado.

Un vendedor **bloqueado por fraude** seguía transmitiendo en el feed de todo el
mundo en el segundo siguiente a la sanción. Se le cerraba la vidriera y se le
dejaba el micrófono, que en una app de venta en vivo es al revés.

El mismo agujero dejaba al aire a quien cerraba su cuenta mientras transmitía,
con el cartel «Cuenta eliminada» encima.

**Corregido con** 4 tests, incluido el contrapeso: *un vendedor en regla SIGUE
apareciendo*. Sin ése, un filtro demasiado estricto vaciaría el feed y los
otros tres pasarían igual, porque los tres afirman ausencias.

### P2 · Privacidad — el DNI propio no estaba en la lista de redacción
`a90a4c5`

`*.docNumber` es el nombre que le da Mercado Pago al documento. La columna
propia se llama `documentNumber` y no estaba tapada. La protección funcionaba
cuando el dato venía del proveedor y fallaba cuando venía de nuestra base, que
es la que lo tiene completo.

Camino concreto: `direccionParaEnviar` arma el objeto que se guarda en
`shipping_address` de cada orden, con el documento adentro.

### P2 · Android — la app se respaldaba en Drive y al restaurar clonaba el dispositivo
`d507a47`

`allowBackup` vale `true` si nadie dice lo contrario. Android subía a la cuenta
de Google Drive de cada persona el identificador de instalación, la URL del
backend y el blob cifrado de la sesión.

Lo que se ve no es la fuga —el blob está cifrado con una clave del Keystore que
no se respalda— sino el clon: restaurar en un teléfono nuevo copia
`device.installId`, y dos aparatos con el mismo identificador rompen «cerrar la
sesión de este dispositivo».

Hizo falta además `reglas_de_extraccion.xml`: desde Android 12 son dos
mecanismos, y `allowBackup` sólo apaga la copia en la nube.

### P2 · Dinero — el ejemplo del vendedor tenía la comisión escrita a mano
`cb14f66`

La pantalla de políticas muestra «cuánto va a ver quien compre» y lo recalcula
en cada tecla. Las dos tasas estaban puestas a mano en el Dart: 600 y 619, los
mismos valores que el backend usa por omisión. Daba bien de casualidad.

El día que se mueva `VENDOX_PLATFORM_FEE_BPS`, el vendedor sigue leyendo
«Comisión de VendoX (6 %)» y una resta que ya no es la suya. Nada falla, nada
avisa.

El propio código ya decía qué hacer: *«Derivados, para que la app no
reimplemente las reglas y se desincronice»*.

### P3 · Dinero — el neto se probaba en un lado y se calculaba en otro
`f8a197d`

`netoConCostoDeProcesador` vive en `pricing.ts` y tiene dos tests. `src/` nunca
la llamaba: `recalcularNeto` repetía la resta a mano. Lo probado no era lo que
corría.

Las dos daban el mismo número, así que no hubo error de plata. Lo que había era
una prueba que no protegía nada — que en dinero es peor que no tenerla, porque
figura en el conteo.

---

## 3. Falsos positivos: sabotajes que no rompían nada

El hallazgo más útil de la noche no son los bugs sino esto. Cinco veces se
rompió una protección a propósito y **la suite entera siguió en verde**.

| # | Qué se rompió | Tests que fallaban antes | Ahora |
|---|---|---|---|
| 1 | `variantOf` pierde la atadura al producto | **0** de 817 | 2 |
| 2 | Direcciones sin `userId` en el WHERE | **0** de 819 | 3 |
| 3 | La rama de rechazo pierde `status: 'PROCESSING_PAYMENT'` | **0** de 828 | 1 |
| 4 | `activos()` ignora el estado del vendedor | **0** de 822 | 3 |
| 5 | `marcarConfirmada` pierde `status: 'PAID'` | **0** de 829 | ver nota |

**1 · Variante ajena con un producto propio.** Los tests que había mandaban el
producto *de la víctima*, así que los frenaba el primer salto y el tercero
nunca se ejercitaba. El ataque real usa un producto propio —existe, es suyo—
con el `variantId` de otro colgado. Tres operaciones dependían de ese filtro:
cambiar el precio, borrar la variante y **mover el stock**. La última es la
peor: poner en cero el stock de la competencia durante su vivo no cuesta nada.

**2 · Dirección de otro.** El comentario del archivo decía «Ajena = no
encontrada» y nada lo comprobaba. No era sólo escritura: `update` devuelve la
fila completa, así que modificar la dirección ajena respondía con el nombre, el
DNI, el teléfono y la calle de la víctima. *(El camino de checkout sí estaba
atado — se verificó.)*

**3 · Despagar un pedido.** La más cara. Llega el rechazo del primer intento
—la tarjeta que no funcionó— cuando el pedido ya está pago con la segunda. Sin
la guarda, lo encuentra en `PAID` y lo pasa a `PAYMENT_FAILED`: alguien pagó,
el pedido figura como fallido, el stock se libera y el vendedor nunca despacha.

**5 · Nota honesta.** Acá el test nuevo prueba el *par* de capas, no la línea:
quitar el retorno temprano de `confirmarInventario` deja el test verde porque
alcanza el `updateMany` condicionado, y al revés también. Quitar las dos lo
hace fallar. Se documentó así en vez de fingir que cubre una sola.

---

## 4. Bugs encontrados y NO corregidos, con el motivo

| Hallazgo | Severidad | Por qué no se tocó |
|---|---|---|
| `PAID → PAYMENT_REQUIRES_REFUND` resiste sabotaje sin que falle nada | P3 | No se encontró camino alcanzable: el retorno temprano de `confirmarInventario` lo cubre. Un test que no prueba lo que dice es peor que ninguno. |
| Tres listas distintas de «qué cuenta como venta» | P2 | `admin` y `risk` cuentan `CONFIRMED…DELIVERED`; `analitica` incluye además `PAID`. Las tres excluyen `REFUNDED`, y cada una tiene un motivo defendible. Unificarlas toca scoring de riesgo durante el freeze. |
| `AuthEvent` y `AuditLog` guardan IP y user-agent sin retención visible | P2 | **Decisión comercial/legal.** Las bitácoras suelen tener obligación de conservarse. Hay que definir el plazo, no borrarlas por gusto. |
| `Notification.body`, `SupportMessage.body` y `SellerVerification` sobreviven al cierre de cuenta | P2 | Igual: define un plazo de retención, no un bug. La verificación no guarda imágenes de documentos — sólo un HMAC y los últimos cuatro. |
| `uses-feature` de Bluetooth implícito y requerido | P3 | Lo agrega el permiso `BLUETOOTH_CONNECT`. Con `required` por omisión, Play oculta la app en aparatos sin Bluetooth — que entre teléfonos Android no existen. Es el mismo caso que la cámara, pero sin impacto real: se anota y no se toca durante el freeze. |
| `barrerReaperturas` hace una consulta por tienda cada 30 s | P3 | Escala lineal con el número de tiendas con horario. A escala beta es irrelevante. Ver §7. |
| El feed de vivos hace seq scan sobre `sellers` | P3 | Es la elección **correcta** del planificador cuando el 90 % de las filas matchea. Medido: 1,0 ms con 5 000 vendedores. |

---

## 5. Lo que se verificó y está bien

No todo hallazgo es un problema. Esto se atacó y resistió:

**Autorización** — 13 blancos saboteados. Resistieron con tests: pedidos del
vendedor (1 test falla), pedido del comprador (2), cancelar el de otro (1),
producto ajeno (9), tienda ajena (3), ticket de soporte ajeno (2), cupón ajeno
(1), notificaciones de otro (2), vivo ajeno (3), guard de roles (6). El rol se
lee de la BASE en cada petición, no del token: degradar a alguien le corta el
acceso con el mismo token, y hay tests en dos archivos.

**Dinero** — un solo lugar calcula la comisión (`pricing.ts:156`). El
`application_fee` que se le manda a Mercado Pago lee el valor persistido, no
recalcula. El redondeo de Dart y el de TypeScript se verificaron idénticos.
Las devoluciones son idempotentes por índice único parcial y por clave de
idempotencia. Ninguna consulta de volumen cuenta órdenes devueltas.

**Privacidad** — el cierre de cuenta borra identidades, tokens de push,
historial de navegación y vacía las direcciones. No se guardan imágenes de
documentos de identidad en ningún lado. Redis no lleva datos personales (sólo
rate-limit, colas y el adaptador de sockets). R2 sólo guarda `products/<id>/…`,
que es público por diseño. La exportación de datos no tiene superficie de IDOR:
el id sale del token, no de la URL.

**Rendimiento** — medido con volumen real, no leído. Feed de productos: índice,
22 buffers, 0,2 ms con 60 000 productos. Feed de vivos: índice, 194 buffers,
1,0 ms con 5 000 vendedores y 200 vivos.

**El binario** — se recompiló al terminar la noche y se verificó en el APK, no
en el código fuente: `allowBackup=false`, `fullBackupContent=false`,
`dataExtractionRules` presente, `autoVerify=true`, `com.vendox.app`,
versionCode 1 / versionName 0.1.0, cámara/autofoco/micrófono
`uses-feature-not-required`, **6** tipografías Inter empaquetadas, **0**
apariciones de `fonts.gstatic.com`, y **0** coincidencias en el escaneo de
secretos.

---

## 6. Master QA plan

Prioridades: **P0** rompe el lanzamiento · **P1** rompe una compra ·
**P2** molesta · **P3** cosmético.

### Bloque A · Arranque y cuenta

| PRUEBA | PASOS | RESULTADO ESPERADO | SEV |
|---|---|---|---|
| Primer arranque sin red | Modo avión → abrir la app | Tipografía Inter correcta, mensaje de sin conexión, no se cae | P1 |
| Registro con Google | Entrar con Google en build **firmada** | Sesión iniciada, sin `ApiException: 10` | **P0** |
| Declarar edad | Intentar comprar sin fecha de nacimiento | Pide la fecha antes de dejar avanzar | P1 |
| Menor de 18 | Declarar una fecha de menos de 18 años | Rechaza y explica | **P0** |
| Cerrar sesión de este dispositivo | Dos teléfonos, cerrar en uno | El otro sigue con sesión | P1 |
| Cerrar la cuenta | Sin pedidos abiertos → eliminar cuenta | 200, y la tienda pública devuelve 404 | P1 |
| Cerrar con pedido en curso | Con un pedido pago → eliminar | 409 explicado, la sesión NO se cierra | P1 |

### Bloque B · Descubrimiento

| PRUEBA | PASOS | RESULTADO ESPERADO | SEV |
|---|---|---|---|
| Feed sin vivos | Abrir con nadie transmitiendo | Estado vacío real, sin números inventados | P2 |
| Filtro EN VIVO AHORA | Tocar el filtro | Sólo vivos reales | P1 |
| Bloquear una tienda | Bloquear a un vendedor que transmite | Su vivo desaparece del feed | P1 |
| Desbloquear | Quitar el bloqueo | Su vivo vuelve | P2 |
| Vendedor sancionado | Que un admin lo suspenda mientras transmite | Su vivo desaparece del feed de todos | P1 |

### Bloque C · Compra

| PRUEBA | PASOS | RESULTADO ESPERADO | SEV |
|---|---|---|---|
| Compra completa | Reservar → dirección → pagar con tarjeta de prueba | Pedido `CONFIRMED`, stock descontado | **P0** |
| Precio exclusivo LIVE | Comprar durante un vivo con precio especial | Cobra el precio del vivo, no el de lista | **P0** |
| Comisión sobre lo pagado | Pedido con descuento | Comisión = 6 % del precio **con** descuento, nunca sobre el envío | **P0** |
| Última unidad, dos compradores | Dos teléfonos, mismo producto, 1 en stock | Uno compra, el otro ve «sin stock». Nunca los dos | **P0** |
| Reserva vencida | Reservar, esperar el vencimiento, pagar | O consigue stock disponible, o queda para devolver. Nunca vende de menos | **P0** |
| Pago rechazado | Tarjeta de rechazo de MP | Mensaje claro, se puede reintentar | P1 |
| Sin señal a mitad del pago | Cortar la red al tocar Pagar | El pedido no queda a medias; el conciliador lo resuelve | P1 |
| Cupón inválido | Aplicar un código que no existe | Se rechaza; el total no cambia | P1 |
| Cupón dos veces | Aplicar el mismo cupón dos veces | Se cuenta una | P1 |
| Envío con costo | Tienda con envío fijo | El envío se suma al total y NO paga comisión | **P0** |
| Retiro en persona | Tienda con retiro | Sin costo de envío, sin dirección obligatoria | P1 |

### Bloque D · Entrega

| PRUEBA | PASOS | RESULTADO ESPERADO | SEV |
|---|---|---|---|
| Código de entrega | El vendedor pide el código al entregar | Sólo el código correcto marca entregado | **P0** |
| Código incorrecto | Probar un código cualquiera | Rechaza y no marca nada | **P0** |
| El vendedor no ve el código | Revisar la pantalla del vendedor | El código nunca aparece de su lado | **P0** |
| Cancelar el comprador | Cancelar antes de que se prepare | Se cancela y se libera el stock | P1 |

### Bloque E · Vender

| PRUEBA | PASOS | RESULTADO ESPERADO | SEV |
|---|---|---|---|
| Sin Mercado Pago conectado | Intentar publicar | Bloqueado y explicado | **P0** |
| Conectar Mercado Pago | Flujo OAuth completo | Vuelve conectado; la app nunca ve un token | **P0** |
| Transmitir | Iniciar un vivo | Video al aire en menos de 5 s | **P0** |
| Teléfono sin cámara | Emulador sin cámara | Estado claro, NO se cae | P1 |
| Destacar un producto | Destacar durante el vivo | Aparece en el celular de quien mira | P1 |
| Perder la red transmitiendo | Modo avión 10 s durante el vivo | Reconecta o marca reconectando; no da por terminado | P1 |
| Ejemplo de precio | Cambiar el costo de envío en Políticas | El ejemplo se recalcula con la comisión del SERVIDOR | P2 |
| Stock incremental | «Me entraron 10 más» | Suma 10, no reemplaza | P1 |

### Bloque F · Avisos y enlaces

| PRUEBA | PASOS | RESULTADO ESPERADO | SEV |
|---|---|---|---|
| Permiso de avisos | Comprar por primera vez | Pide permiso DESPUÉS de la compra, con explicación propia | P1 |
| Aviso de pago | Pagar un pedido | Llega **un** aviso, no dos | P1 |
| Webhook duplicado | Reenviar el webhook a mano | Sigue llegando **un** solo aviso | **P0** |
| Contenido del aviso | Leer un aviso de venta | Sin importe, sin dirección, sin código de entrega | **P0** |
| Deep link con la app cerrada | Tocar `vendox.com.ar/p/<id>` | Abre la app en el producto | P1 |
| Deep link con la app abierta | Ídem, con la app en primer plano | Navega sin reiniciar | P1 |
| Enlace desconocido | `vendox.com.ar/loquesea` | **No** manda al feed en silencio | P1 |
| Página web | `vendox.com.ar/privacidad` | Abre el navegador, no una pantalla de la app | P2 |
| Cerrar sesión | Salir de la cuenta | El token de push se desvincula | P1 |

---

## 7. Runbooks de incidentes

### 7.1 · Mercado Pago no responde

| | |
|---|---|
| **SÍNTOMA** | Los pagos quedan en `PROCESSING_PAYMENT`. Sube `payment_attempts{result="unknown"}` |
| **QUÉ MIRAR** | Estado de MP · logs con `traceId` · cuántas órdenes atascadas |
| **QUÉ NO HACER** | ❌ **No marcar órdenes como pagas a mano.** ❌ No reintentar el cobro con otra clave de idempotencia: cobra dos veces |
| **RECUPERACIÓN** | El conciliador le pregunta a MP y resuelve solo. Si MP sigue caído, las reservas vencen y el stock vuelve. Nadie pierde plata |

### 7.2 · Webhooks duplicados o fuera de orden

| | |
|---|---|
| **SÍNTOMA** | Un pedido aparece dos veces en la bitácora |
| **QUÉ MIRAR** | `mp_webhook_events` por `notificationId` · el estado real de la orden |
| **QUÉ NO HACER** | ❌ No «arreglar» el estado a mano antes de leer los eventos |
| **RECUPERACIÓN** | Ninguna: es el comportamiento esperado. Las guardas de monotonía hacen que el duplicado afecte cero filas. Cubierto por tests |

### 7.3 · Sobreventa reportada

| | |
|---|---|
| **SÍNTOMA** | Un vendedor dice que vendió más de lo que tenía |
| **QUÉ MIRAR** | `inventory` de la variante · `inventory_reservations` · si el vendedor bajó el stock a mano después de vender |
| **QUÉ NO HACER** | ❌ No subir el stock para «tapar» el número: destruye la evidencia |
| **RECUPERACIÓN** | La sobreventa es imposible por construcción (UPDATE condicional + CHECK). Si aparece, es un ajuste manual del vendedor. Mostrarle la bitácora |

### 7.4 · LiveKit caído

| | |
|---|---|
| **SÍNTOMA** | Los vivos no arrancan o cortan |
| **QUÉ MIRAR** | Estado de LiveKit Cloud · `live_sessions` en `RECONNECTING` |
| **QUÉ NO HACER** | ❌ No borrar las sesiones: el comercio del vivo sigue siendo válido |
| **RECUPERACIÓN** | El video es independiente del comercio. Los pedidos hechos durante el vivo siguen su curso. Las sesiones terminan solas |

### 7.5 · Redis caído

| | |
|---|---|
| **SÍNTOMA** | Se cae el rate-limit, las colas y el chat del vivo |
| **QUÉ MIRAR** | `/health` · conexión de BullMQ |
| **QUÉ NO HACER** | ❌ No desactivar el rate-limit «mientras tanto» |
| **RECUPERACIÓN** | Levantar Redis. Las colas retoman los trabajos pendientes. Ningún dato de plata vive en Redis |

### 7.6 · PostgreSQL caído

| | |
|---|---|
| **SÍNTOMA** | Todo falla |
| **QUÉ MIRAR** | Railway · conexiones abiertas · espacio en disco |
| **QUÉ NO HACER** | ❌ **No restaurar un backup sin antes exportar el estado actual.** ❌ No correr migraciones a mano para «destrabar» |
| **RECUPERACIÓN** | Levantar la base. Las transacciones a medias revierten solas. Después: conciliar contra MP los cobros de la ventana caída |

### 7.7 · Filtración de una credencial

| | |
|---|---|
| **SÍNTOMA** | Una clave apareció donde no debía |
| **QUÉ MIRAR** | Cuál, desde cuándo, y quién pudo verla |
| **QUÉ NO HACER** | ❌ **No pegar la clave en ningún chat, ticket ni commit** — ni para reportarla |
| **RECUPERACIÓN** | Rotar en el proveedor → actualizar en Railway → reiniciar → revisar la bitácora del período. Si es la de MP: revisar cobros del período |

### 7.8 · Deep links abren el navegador en vez de la app

| | |
|---|---|
| **SÍNTOMA** | Tocar un enlace de `vendox.com.ar` abre Chrome |
| **QUÉ MIRAR** | Que `/.well-known/assetlinks.json` responda 200 con `content-type: application/json` · que la SHA-256 de la build coincida con alguna de las dos publicadas |
| **QUÉ NO HACER** | ❌ No inventar ni reemplazar huellas. ❌ No sacar `autoVerify` para «probar» |
| **RECUPERACIÓN** | Corregir el archivo y **reinstalar** la app: Android sólo verifica al instalar. Es un modo de falla silencioso — no hay error en el log del teléfono |

### 7.9 · Avisos duplicados o al destinatario equivocado

| | |
|---|---|
| **SÍNTOMA** | Alguien recibe dos avisos, o uno que no le corresponde |
| **QUÉ MIRAR** | `notifications` por `dedupeKey` · el listener que lo emitió |
| **QUÉ NO HACER** | ❌ No borrar avisos de la base para «limpiar» |
| **RECUPERACIÓN** | El `dedupeKey` tiene índice único global: un duplicado real implica claves distintas para el mismo hecho. Corregir la clave, no borrar filas |

---

## 8. Checklist cronológica de producción

El orden importa: cada paso depende del anterior.

### Fase 1 · Dominio *(tu socio · bloquea todo lo demás)*

1. **Publicar `web/` en Cloudflare Pages** → `vendox.com.ar`
2. **Verificar** que `https://vendox.com.ar/privacidad` y `/eliminar-cuenta` responden 200
3. **Crear `api.vendox.com.ar`** apuntando al backend de Railway
4. **Email routing** para `privacidad@vendox.com.ar`

> Sin la fase 1 no hay App Links, no hay política publicada y Play rechaza el envío.

### Fase 2 · Backend *(tu socio · depende de la 1)*

5. **Desplegar el backend en Railway** con todas las variables de entorno
6. **`prisma migrate deploy`** contra la base de producción
7. **Cargar `ANDROID_CERT_SHA256`** con las DOS huellas (Play + subida)
8. **Verificar** que `https://vendox.com.ar/.well-known/assetlinks.json` devuelve las dos
9. **Configurar el webhook de Mercado Pago** apuntando a `api.vendox.com.ar`
10. **Probar `/health`** desde fuera de Railway

### Fase 3 · App *(vos · depende de la 2)*

11. **Generar la clave de subida** (`keytool`) y guardarla **fuera del repo**
12. **Crear `mobile/android/key.properties`** desde el `.example`
13. **Definir la URL de producción** en el `--dart-define`
14. **Compilar el AAB firmado**
15. **Escanear secretos** en el binario
16. **Instalar en un teléfono real** y correr la primera prueba manual (§10)

### Fase 4 · Play Console *(vos · depende de la 3)*

17. **Subir el AAB** a prueba interna
18. **Completar Data Safety** con la matriz ya preparada
19. **Enlazar la política de privacidad**
20. **Cargar la cuenta de revisión** `review@vendox.com.ar` con sus instrucciones
21. **Verificar App Links** desde el teléfono, con la app instalada desde Play

---

## 9. Lo que necesita cada uno

### Tu socio

- [ ] Publicar `web/` en Cloudflare Pages
- [ ] Crear `api.vendox.com.ar`
- [ ] Email routing de `privacidad@vendox.com.ar`
- [ ] Desplegar el backend en Railway con sus variables
- [ ] Cargar `ANDROID_CERT_SHA256` en producción
- [ ] Configurar el webhook de Mercado Pago

### Vos

- [ ] Generar la clave de subida (**no hace falta que nadie más la vea**)
- [ ] Definir la URL de producción del backend
- [ ] Compilar el AAB firmado
- [ ] Correr la primera prueba manual (abajo)
- [ ] Completar Data Safety en Play Console
- [ ] **Decidir el plazo de retención** de bitácoras y avisos *(§4 — es una decisión, no un bug)*

---

## 10. La primera prueba manual cuando vuelvas

Una sola, y en este orden. Si falla el paso 2, nada de lo demás importa.

1. **Compilá el APK firmado** e instalalo en tu teléfono real
2. **Entrá con Google.** Es lo único que no se puede verificar sin build
   firmada en dispositivo real, y es lo que bloquea todo lo demás
3. **Comprá algo** con una tarjeta de prueba de Mercado Pago, de punta a punta
4. **Mirá el aviso** que te llega: no puede tener importe, dirección ni código
   de entrega
5. **Cerrá sesión** y verificá que dejan de llegarte avisos

Si el paso 2 falla, lo que hay que mirar es el `serverClientId` —tiene que ser
el cliente **WEB**, no el Android— y que la huella de la build esté registrada
en Firebase. No hay que tocar la arquitectura de auth antes de ver el error
concreto.

---

## 11. Estado del freeze

**Intacto.**

Nueve commits esta noche. Ninguno agrega una feature, cambia navegación, toca
UX o modifica la arquitectura. Cinco arreglan bugs de privacidad, moderación o
dinero. Cuatro agregan tests que faltaban.

Todo verificado ejecutando, no leyendo: lint limpio, tipos limpios,
`flutter analyze` limpio, 1 629 tests de backend y 337 de Flutter en verde, y
cada arreglo con su sabotaje que demuestra que la prueba sostiene algo.
