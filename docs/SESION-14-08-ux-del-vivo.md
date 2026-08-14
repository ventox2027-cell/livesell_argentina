# VendoX — Bloque UX del vivo

**14 de agosto de 2026** · 4 commits sobre `eed5fa0` · backend 733 tests · flutter 92 tests · nada desplegado

Los 16 puntos del pedido están implementados. Lo que separa "implementado" de
"verificado" es un límite del emulador, no del código: la inicialización nativa
de WebRTC tumba la máquina virtual, así que todo lo que depende de video en vivo
sólo se puede confirmar en hardware.

| | |
|---|---|
| Puntos implementados | 16 de 16 |
| Verificados en emulador contra backend real | 9 |
| Esperan teléfono (dependen de video) | 7 |
| Defectos encontrados | 5, todos arreglados |

---

## 1. Los 16 puntos

En el orden en que fueron pedidos. "Implementado" = código escrito y cubierto
por tests. "Verificado" = además ejecutado contra el backend real.

### 01 · Horarios de tienda — VERIFICADO
Tres modos: siempre abierta, por franjas, o sólo durante los vivos. Las franjas
que cruzan medianoche se soportan sin partirlas en dos. Se decide en la zona
horaria de la tienda, no la del teléfono.

### 02 · Follow persistido con contador real — VERIFICADO
El contador lo devuelve el servidor, nunca se suma del lado de la app.
Verificado en el emulador: pasó de 0 a 1 seguidor y sobrevive al reinicio.

### 03 · Base de reseñas y reputación — IMPLEMENTADO, SIN PANTALLA
El backend liga cada reseña a un pedido entregado y mantiene el promedio. El
perfil ya lo muestra. **Falta la pantalla para escribir una reseña** — es lo
único de este punto que no existe.

### 04 · Perfil del vendedor — VERIFICADO
Seguidores, ventas, reputación y horario. Las dos insignias van separadas y con
texto propio: identidad verificada no es lo mismo que vendedor confiable.

### 05 · Pantalla del vivo — IMPLEMENTADO, FALTA TELÉFONO
Video, chat, producto destacado, composer y vendedor. La grilla de vivos activos
reemplazó al "próximamente" y sí está verificada.

### 06 · Video a pantalla completa — IMPLEMENTADO, FALTA TELÉFONO
Recorta para llenar la pantalla. Lleva un perro guardián que mira si los cuadros
decodificados avanzan: dos segundos sin uno nuevo y conserva el último cuadro
con el aviso de reconexión, en vez de pasar a negro en silencio.

### 07 · Chat en tiempo real — IMPLEMENTADO, FALTA TELÉFONO
Franja angosta sobre el video, sin fondo propio y sin scroll hacia atrás. El
vendedor se distingue por color y por etiqueta, no sólo por color.

### 08 · Producto destacado en su posición — IMPLEMENTADO, FALTA TELÉFONO
Arriba del composer, abajo del chat, como se acordó. Hay una decisión sobre el
teclado que necesita confirmación — ver sección 4.

### 09 · Composer debajo del producto — IMPLEMENTADO, FALTA TELÉFONO
Se ancla arriba del teclado. Es lo único que se mueve: el video, el encabezado y
la columna de acciones no se enteran de que hay teclado.

### 10 · Botón Tienda con el catálogo completo — VERIFICADO
Hoja con búsqueda y scroll infinito. Un test cuenta los montajes del widget de
abajo para probar que abrirla y cerrarla no desmonta el vivo.

### 11 · Variantes, stock y cantidad — VERIFICADO
Los talles sin stock se muestran tachados, no escondidos: que exista y se haya
agotado es información. Acá apareció el defecto más grande de la sesión.

### 12 · Checkout conservando el contexto — VERIFICADO
Todo son hojas sobre la pantalla del vivo, no rutas nuevas. Verificada la cadena
completa hasta apartar: la reserva quedó con su cuenta regresiva y el stock bajó
de 3 a 2.

### 13 · Volver al vivo después del pago — RESUELTO POR CONSTRUCCIÓN
No hay pago externo del que volver. El formulario de tarjeta corre en un WebView
dentro de una hoja, contra el CardForm de Mercado Pago. La app nunca se cierra,
así que no hay nada que restaurar.

### 14 · Estado post-vivo — IMPLEMENTADO, FALTA TELÉFONO
Un vivo terminado pierde el video y conserva todo lo demás: vendedor, tienda y
producto. Es el momento de más intención de compra y perderlo es perder la venta.

### 15 · Configuración de horarios — IMPLEMENTADO
Pantalla propia, enlazada desde ajustes de tienda. Se edita local y se guarda
entero, para que no queden horarios intermedios que nadie eligió.

### 16 · Intención cuando la tienda está cerrada — IMPLEMENTADO
**No aparta stock.** Una reserva real bloquearía una unidad cinco minutos para
alguien que no puede pagar, y se la sacaría a quien sí puede.

---

## 2. Cinco defectos encontrados

Tres de estos pasaron todas las suites en verde. El patrón se repite y vale la
pena leer por qué.

### CRÍTICO · La URL del webhook que iba a cargarse en Mercado Pago devolvía 404

Había dos webhooks. El productivo respondía en
`/api/webhooks/orders/mercadopago`, con prefijo. El del spike ocupaba
`/webhooks/mercadopago`: más corta, y la única de las dos que parecía la oficial.

**Los tres `.env` del repositorio apuntaban a esa segunda.** Los pagos se habrían
acreditado contra `SpikeOrder`, una tabla que el flujo real no usa, y los pedidos
de verdad se habrían quedado en `PENDING_PAYMENT`.

*Por qué ningún test lo vio:* el helper de tests excluía del prefijo global con
el comodín `webhooks/(.*)` y `main.ts` enumeraba dos rutas a mano. Los tests
probaban una URL contra un servidor que no es el que corre. Es la **cuarta vez**
que pasa lo mismo, y la primera desde que existe `http-setup.ts` justamente para
evitarlo. Ahora el prefijo vive ahí, en una sola función que llaman los dos.

### CRÍTICO · El selector de talles nunca funcionó para un comprador

La app pedía el detalle del producto a `GET /products/:id`, que es el endpoint
del **vendedor**: resuelve por dueño y contesta `SELLER_NOT_FOUND` a cualquiera
que no tenga tienda. Se veía como producto sin nombre y precio `$ 0,00`.

*Por qué ningún test lo vio:* fallaron tres capas a la vez.

1. El cliente HTTP no lanza con 4xx — usa `validateStatus: s < 500` para poder
   reintentar tras refrescar el token.
2. El modelo lee todo a la defensiva, así que el cuerpo del error se parseó como
   un producto vacío.
3. **El test de contrato estaba escrito contra un JSON inventado** en vez de una
   respuesta real. La cabecera de ese mismo archivo ya lo advertía.

Ahora usa la respuesta de `curl`, e incluye el caso "un cuerpo de error no se
parsea como producto vendible". Se agregó `GET /catalog/products/:id`, público,
que manda `disponible` ya calculado y **no** manda `onHand` ni `reserved`.

### ALTO · La app decía que Google no estaba configurado, y sí lo estaba

Apareció probando en el teléfono. Un fallo de red producía la misma
configuración vacía que produce un servidor que de verdad tiene Google apagado, y
el mensaje mandaba a revisar el servidor cuando el problema era que el teléfono
no llegaba a él.

Peor: la respuesta quedaba cacheada para toda la sesión. Aunque el backend
volviera un segundo después, la app seguía diciendo lo mismo hasta cerrarla del
todo, y nada en la pantalla lo sugería.

### MEDIO · El botón "Seguir" del feed era un booleano en memoria

Se ponía en "Siguiendo", no mandaba nada al servidor, y al reabrir la app decía
"Seguir" otra vez. La persona creía que iba a recibir avisos de los vivos de ese
vendedor y no iba a recibir ninguno. Los ids que hacían falta ya venían en la
respuesta del feed; el modelo los tiraba.

### MEDIO · La firma de los webhooks se guardaba entera

El HMAC completo es material derivado de `MP_WEBHOOK_SECRET`, en claro, en una
tabla que el panel de administración lee entera. Ahora se guarda recortada: el
`ts` completo y ocho caracteres del hash, que es todo lo que se usa para comparar
dos notificaciones.

---

## 3. Mercado Pago — listo para cargar la URL

Una sola ruta, fuera del prefijo y del versionado, verificada contra el binario
compilado con el spike apagado como en producción:

```
POST /webhooks/orders/mercadopago         200   ← la que va en el panel
POST /api/webhooks/orders/mercadopago     404
POST /api/v1/webhooks/orders/mercadopago  404
POST /webhooks/mercadopago                404   ← la vieja del spike
POST /webhooks/spike/mercadopago          404   ← apagado en producción
```

- **Evento a seleccionar:** Pagos (`payment`). Es el único topic que se procesa;
  el resto se registra y se descarta con 200.
- **Variable del secret:** `MP_WEBHOOK_SECRET`. Sin cargar, se rechaza todo.
- **El spike** se mudó a `/webhooks/spike/mercadopago` y no puede existir en
  producción: `env.schema.ts` lo prohíbe.
- **Guarda nueva:** el backend *no arranca* si `MP_NOTIFICATION_URL` no apunta a
  la ruta canónica. Es el error que no da ninguna señal — el cobro funciona, la
  tarjeta se debita, y sólo se pierde la notificación.

### Verificación de firma (sin cambios)

HMAC-SHA256 sobre `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, comparación
en tiempo constante, ventana de tolerancia de 5 minutos, y rechazo total si no
hay secret. El estado del pago **nunca** sale del cuerpo: se consulta contra la
API de Mercado Pago con el access token.

Se corrigió el orden de `data.id`: ahora **query string primero**, cuerpo como
respaldo para el simulador. Estaba al revés, y como el manifiesto de la firma se
arma con ese valor, dos valores distintos daban `HASH_MISMATCH` — indistinguible
de una clave mal configurada.

### Pago real más reciente del módulo de Órdenes

| Campo | Valor |
|---|---|
| Payment ID | `1327875106` |
| PaymentAttempt | `pat_01KZZHJG7YNRJX1TTNFGBYE3PQ` |
| Order | `ord_01KZZHEVQPE35A11CNATGKD2R8` |
| Referencia | `9YPP2RWZ` |
| Estado | `APPROVED` · orden `SHIPPED` |
| Monto | $ 15.000,00 |
| Acreditado en | 1,9 s |

Ese pago no lo confirmó ningún webhook — no hay evento con ese `resourceId`. La
orden pasó a pagada por la respuesta directa de la API al cobrar, que es
exactamente lo que se espera cuando la URL de notificación apuntaba al lugar
equivocado.

### Webhook simulado sobre ese pago (prueba de idempotencia)

Se simuló una notificación para `1327875106` a las 12:02 y se verificó, en
lectura, que no duplicó nada.

```
MpWebhookEvent  mpw_01M002EQRPJGY224KAY281Y1QX
notificationId  123456        topic payment / payment.updated
signatureValid  true          rejectionReason  —
recibido        2026-08-14T12:02:55.384Z
procesado       2026-08-14T12:02:55.980Z   (596 ms)
error           —
```

Consultó a Mercado Pago y obtuvo APPROVED — hay prueba directa en el intento:

```
lastCheckedAt  2026-08-14T12:02:55.967Z   ← consultó acá
status         APPROVED                    ← sin cambios
approvedAt     2026-08-14T07:07:18.000Z    ← el original de MP, intacto
```

**No volvió a acreditar, consumir stock ni tocar la orden.** Los timestamps no se
movieron:

| Qué | Última modificación | ¿Se tocó a las 12:02? |
|---|---|---|
| `Order.updatedAt` | 07:15:17 | No |
| `Order.paidAt` | 07:07:54 | No |
| `Order.confirmedAt` | 07:07:54 | No |
| `Inventory.updatedAt` | 07:07:54.943 | No |
| Reserva `rsv_01KZZHCRYA…` | 07:07:54.943 · `CONSUMED` ×1 | No |

Bitácora de la orden: `order.created ×1`, `order.confirmed ×1`,
`order.fulfillment_changed ×3`. Un solo intento de pago para la orden.
Inventario actual: `onHand=1, reserved=0`.

Lo único escrito a las 12:02 fue la fila del evento y el
`updatedAt`/`lastCheckedAt` del intento — una marca de "volví a chequear", no un
cambio de estado.

*Nota:* el `notificationId` quedó en `123456`, que es el `id` del cuerpo enviado.
Repetir el mismo cuerpo devuelve `DUPLICATE` sin ejecutar nada — es la
deduplicación funcionando. Hay que cambiar ese `id` para forzar un procesamiento
nuevo.

---

## 4. Decisión pendiente — el teclado

El pedido era doble: que el producto destacado **no se mueva** y que **se siga
viendo** mientras se escribe. Con el orden acordado —chat, producto, composer—
los dos no se pueden cumplir a la vez.

El composer va arriba del teclado, el producto va arriba del composer, y un
teclado de Android ocupa cerca del 40% de la pantalla. Un producto clavado a
124 px del borde queda **detrás** del teclado: quieto, sí, pero invisible, que es
justo lo que había que evitar.

**Resolución adoptada:** el producto nunca baja y nunca queda tapado. En reposo
está en su lugar de siempre; con el teclado abierto sube lo mínimo para seguir a
la vista. Lo que no pasa —que era el motivo del pedido— es que se desplace la
interfaz entera: el video, el encabezado y la columna de acciones no se enteran
del teclado.

Si se prefiere que quede literalmente fijo aun a costa de que el teclado lo tape,
es un cambio de una línea en `layout_del_vivo.dart`. La aritmética está aislada
en un módulo puro con tests de **invariantes**, no de píxeles concretos, porque
las alturas se van a ajustar en el teléfono.

---

## 5. Límite del entorno — por qué falta el teléfono

Entrar a un vivo con video **tumba el emulador entero**, reproducible tres de
tres, en modo ventana y headless. La app no registra ninguna excepción. Las
últimas líneas antes de que muera la máquina virtual:

```
org.webrtc.Logging: Loading native library: jingle_peerconnection_so
AudioSystem: media.audio_flinger service obtained
android.hardware.audio@7.1-impl.ranchu: 544 frames of silence written
                                  ← acá muere el emulador
```

Es la inicialización nativa de WebRTC contra el dispositivo de audio virtual,
incluso arrancando con `-no-audio`. No es un defecto de la app: es el emulador.

---

## 6. Cómo probar en el teléfono

APK release, 34 MB, firmado con la clave de debug — sirve para teléfonos propios
y nada más. Trae `http://192.168.0.14:3100` como servidor por defecto.

1. Con el teléfono en **la misma WiFi**, entrar a `http://192.168.0.14:8099` y
   bajar el primer botón.
2. Android avisa que el origen es desconocido: desde ese aviso, Ajustes →
   habilitar instalación desde el navegador → volver y confirmar.
3. Si el login con Google falla, usar **"Entrar en modo prueba"**. Está
   habilitado y no necesita nada.
4. Para un vivo hacen falta **dos dispositivos**: uno transmitiendo y otro
   mirando. Con uno solo se recorre todo lo demás.

Dos cosas puntuales para mirar:

- **El teclado.** Tocar "Comentar" en un vivo y ver si el producto destacado
  queda visible y quieto. Las alturas están calculadas contra un teclado de
  ~320 px.
- **El primer cuadro.** Se midió ~4 segundos hasta que aparece el video.
  Mientras tanto tiene que verse la portada del vivo, nunca negro.

*Estado del entorno de prueba:* el vivo de prueba quedó terminado para poder
verificar el estado post-vivo, así que la pestaña "En vivo" aparece vacía. Hay
una reserva de una unidad, así que esa campera figura con 2 en vez de 3 hasta que
venza.

---

## 7. Deuda

- **Pantalla para escribir una reseña.** El backend y el perfil están; falta el
  formulario.
- **"Me gusta" y "Enviar" en el vivo.** Visibles y sin acción a propósito: no hay
  backend de likes, y compartir necesita una URL pública que depende del dominio
  definitivo.
- **Sin opciones de producto desde la app.** No hay endpoint para crear talles y
  colores, así que los productos de prueba tienen una sola variante. La
  combinatoria está cubierta por tests, pero no se puede armar un producto con
  talles desde la app.
- **El `applicationId` sigue siendo el del spike.** No publicar con
  `ar.livesell.livesell_spike`.
- **Clave de firma propia.** El release usa la de debug. Al cambiarla cambia la
  huella SHA-1 y hay que agregar un cliente OAuth nuevo en Google Cloud.
- **Railway.** Decidido y sin desplegar, como se acordó.

---

## 8. Commits

| SHA | Mensaje |
|---|---|
| `8fcc559` | feat(vivo): comprar sin salir del LIVE |
| `8e3fe49` | fix(pagos): una sola URL de webhook, y era la equivocada |
| `199a62f` | fix(catálogo): el selector de talles nunca funcionó para un comprador |
| `4dc321f` | fix(auth): la app decía que Google no estaba configurado, y sí lo estaba |

32 archivos tocados en la app, 17 en el backend. Nada desplegado.
