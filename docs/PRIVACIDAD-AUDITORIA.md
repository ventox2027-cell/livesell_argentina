# Auditoría de datos personales

Inventario campo por campo, leído del código el 15 de agosto de 2026.

De acá salió cada afirmación de
[`/privacidad`](../web/privacidad/index.html). **Si el código cambia y este
documento no, la política pública empieza a mentir.**

Método: se leyeron `prisma/schema.prisma` (todo lo que se persiste),
`config/env.schema.ts` (todos los proveedores configurables), el
`AndroidManifest.xml` (todos los permisos) y `pubspec.yaml` (todas las
dependencias del teléfono). No se supuso nada.

---

## 1 · Lo que se encontró y NO se está usando

Empieza por acá porque es lo que más fácil se declara de más.

| Cosa | Estado real |
|---|---|
| **Sentry** | `SENTRY_DSN` y `SENTRY_TRACES_SAMPLE_RATE` existen en `env.schema.ts`. **El paquete no está instalado y nadie lee esas variables.** No hay ningún envío de errores a terceros. No declarar Sentry. |
| **Tarjetas guardadas** | `spike_customers` y `spike_customer_cards` guardan `mp_card_id`, últimos cuatro, marca y vencimiento. Vive en `PaymentsController`, que sólo se registra con `PAYMENTS_SPIKE_ENABLED=true`, y `env.schema.ts` prohíbe que eso sea true en producción. **No aplica en producción.** |
| **WhatsApp** | `users.whatsapp_opt_in` es una preferencia guardada. **Nada envía mensajes de WhatsApp.** No hay integración con la Business Platform. |
| **Ubicación** | Ningún permiso, ninguna dependencia, ningún campo. |
| **Contactos** | Ídem. |
| **Grabación de los vivos** | No existe egress, ni grabación, ni miniaturas. Se buscó `egress`, `recording`, `roomComposite`: cero resultados. |
| **Historial de búsqueda** | No hay tabla ni log. Las búsquedas se resuelven y se descartan. |
| **Notificaciones push** | El backend está entero: outbox, worker, reintentos y FCM HTTP v1. **La app no tiene `firebase_messaging` y nunca envía un token.** `loginConGoogle` acepta `pushToken` y nadie se lo pasa. Ver el hueco al final. |
| **Iniciar sesión con Apple** | Implementado en el backend (`identity.service.ts`). El botón está en la app pero **deshabilitado** hasta que exista la cuenta de desarrollador de Apple. |

---

## 2 · Datos de identidad y cuenta

`users`

| Campo | Contenido | Origen |
|---|---|---|
| `first_name`, `last_name` | Nombre real | Google |
| `email` | Correo | Google |
| `avatar_url` | URL de la foto | Google |
| `phone_e164` | Teléfono | Lo carga la persona antes de comprar |
| `birth_date` | Fecha de nacimiento | Lo carga la persona. Obligatorio para comprar o vender (18+). |
| `birth_date_declared_at` | Cuándo se declaró | Sobrevive al cierre de cuenta: es la constancia de que se preguntó, y no dice nada de la persona |
| `locale`, `timezone` | `es-AR`, `America/Argentina/Buenos_Aires` | Por omisión |
| `password_hash` | **Sólo cuentas demo.** Un CHECK de la base impide que exista en una cuenta normal | Script administrativo |
| `last_seen_at` | Última actividad | Automático |

`user_identities` — `provider` (`google`/`apple`/`phone`), `subject` (el id que
da el proveedor) y `email`. **El `subject` se excluye de la exportación de
datos:** es un identificador del proveedor, no un dato de la persona.

---

## 3 · Datos de entrega

`user_addresses` — la tabla más sensible del sistema.

| Campo | Nota |
|---|---|
| `recipient_full_name` | |
| `document_type`, `document_number` | **DNI completo, en claro.** Los envíos en Argentina lo exigen para acreditar la entrega. |
| `phone_e164` | |
| `street`, `number`, `floor`, `apartment` | Domicilio exacto |
| `city`, `province`, `postal_code` | |
| `references` | Texto libre: «portón negro», «tocar el timbre de al lado» |

Al cerrar la cuenta **se vacían todos estos campos**, no se marcan como
borrados: una fila con `deleted_at` sigue teniendo el DNI adentro. Ver
`auth.service.ts → closeAccount`, con test de sabotaje en `orders-flow.spec.ts`.

`orders.shipping_address` (JSON) guarda una **copia** de la dirección al momento
de la compra. Sobrevive al cierre: es el comprobante de a dónde se mandó un
paquete que efectivamente se mandó. `orders.buyer_snapshot` guarda id, nombre y
correo del comprador por el mismo motivo.

---

## 4 · Datos de pago

**No se guarda ningún dato de tarjeta.** No hay PAN, no hay CVV, no hay
vencimiento en ninguna tabla del flujo productivo.

`payment_attempts` — `provider_payment_id`, `amount`, `currency`, `status`,
`payment_method_type`, `brand`, `last_four`, `failure_code`,
`failure_message_safe`, `processor_fee_amount`.

`last_four` y `brand` son lo que permite reconocer qué tarjeta se usó. Vienen
de la respuesta de Mercado Pago, que pasa antes por `scrubMpPayment`.

`seller_payment_accounts` / `seller_oauth_credentials` — las credenciales de
cobro del vendedor, **cifradas** con `CREDENTIALS_ENCRYPTION_KEY`. No salen del
backend. La app sólo recibe la cuenta enmascarada (`····0220`).

---

## 5 · Datos de vendedor

`seller_verifications`

| Campo | Nota |
|---|---|
| `legal_first_name`, `legal_last_name` | Nombre legal |
| `doc_number_hash` + `doc_number_last4` | **Hash, no el número.** Alcanza para detectar duplicados y no permite reconstruirlo |
| `tax_id_hash` + `tax_id_last4` | Ídem con el CUIT/CUIL |
| `province`, `city` | Sin domicilio exacto |
| `identity_provider`, `identity_result`, `tax_provider`, `tax_result` | Campos preparados para verificación externa. **Hoy no hay ningún proveedor conectado.** |
| `risk_level` (en `sellers`) | Interno. **Se excluye de la exportación de datos:** es una evaluación nuestra, no un dato de la persona |

---

## 6 · Contenido y actividad

| Tabla | Qué guarda | Retención |
|---|---|---|
| `live_chat_messages` | `text`, `user_id`, `blocked_by_filter`, `deleted_at` | **30 días** (`CHAT_RETENCION_DIAS`), barrido diario en `chat-retencion.service.ts` |
| `live_chat_mutes` | Silencios por vivo | Con el vivo |
| `user_blocks` | Quién bloqueó a quién. `reason` es opcional y **la auditoría guarda sólo `{conMotivo: boolean}`**, nunca el texto | Hasta que se deshaga |
| `reports` | `reporter_user_id`, destino, motivo, `detail` (texto libre) | Sin purga automática |
| `moderation_actions` | Acción, actor, motivo obligatorio | Sin purga automática |
| `reviews` | `rating`, `comment`, autor | Con la tienda |
| `follows`, `likes` | Vínculos | Hasta que se deshacen |
| `live_sessions` | Cuándo, cuánta gente, qué productos. **Sin video ni audio** | Sin purga automática |
| `notifications` | Tipo, título, cuerpo, destinatario | Sin purga automática |
| `support_tickets`, `support_messages` | Texto que escribe la persona | Sin purga automática |

---

## 7 · Datos técnicos

| Tabla | Campo | Nota |
|---|---|---|
| `devices` | `platform`, `app_version`, `os_version`, `model`, `install_id`, `timezone` | `install_id` distingue dispositivos para poder cerrar la sesión de uno solo |
| `devices` | `push_token` | Hoy siempre `NULL`: la app no lo envía |
| `refresh_tokens` | `token_hash`, `ip`, `user_agent`, `family_id` | El token se guarda **hasheado** |
| `auth_events` | `kind`, `success`, `reason`, `ip`, `user_agent`, `detail` | Registro de accesos |
| `audit_logs` | Acciones administrativas y del sistema | |

La IP se obtiene con `ipDelCliente()`, que respeta `TRUSTED_PROXY_HOPS`: detrás
de un proxy mal configurado, `req.ip` es el valor que eligió quien llama.

También se usa como sujeto del límite de tasa cuando no hay sesión
(`ip:<addr>`), en memoria o en Redis, no persistido.

---

## 8 · Permisos del teléfono

`AndroidManifest.xml`, la lista completa:

| Permiso | Para qué |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE`, `CHANGE_NETWORK_STATE` | Red |
| `CAMERA` | **Sólo transmitir.** Quien mira no la activa nunca |
| `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Ídem |
| `WAKE_LOCK` | Que la pantalla no se apague durante un vivo |
| `BLUETOOTH_CONNECT` | Auriculares durante un vivo |

**No hay** `ACCESS_FINE_LOCATION`, `READ_CONTACTS`, `READ_EXTERNAL_STORAGE` ni
`POST_NOTIFICATIONS`.

`image_picker` abre el selector del sistema: la app recibe el archivo elegido y
nada más.

---

## 9 · Proveedores realmente conectados

| Proveedor | Para qué | Evidencia |
|---|---|---|
| **Mercado Pago** | Pagos, reembolsos, OAuth de vendedores | `MP_*`, `modules/payments/` |
| **Google Sign-In** | Autenticación | `GOOGLE_CLIENT_ID_*`, `identity.service.ts` |
| **LiveKit** | Transporte de video y audio | `LIVEKIT_*`, `modules/live/` |
| **Cloudflare R2** | Imágenes de productos y tiendas | `R2_*`, `shared/storage/` |
| **Firebase Cloud Messaging** | Notificaciones (backend listo, app no) | `FIREBASE_SERVICE_ACCOUNT_PATH` |
| **Apple** | Autenticación en iPhone | `APPLE_BUNDLE_ID`. Deshabilitado en la app |

PostgreSQL y Redis son infraestructura propia, no terceros que reciban datos.
`DEPLOYMENT_PROVIDER` menciona Railway: **no hay nada desplegado ahí**.

---

## 10 · Qué protege qué

| Dato | Protección | Dónde |
|---|---|---|
| Credenciales MP del vendedor | Cifradas con `CREDENTIALS_ENCRYPTION_KEY` | `seller-oauth.service.ts` |
| Código de entrega | Cifrado, formato `v1.…` | migración `20260815020000` |
| DNI y CUIT del vendedor | Hash irreversible + últimos 4 | `seller_verifications` |
| Refresh tokens | Hasheados | `refresh_tokens.token_hash` |
| Contraseña de la cuenta demo | scrypt N=32768 | `shared/crypto/contrasenas.ts` |
| Todo en tránsito | HTTPS | |

**Redacción de logs** — `logger.config.ts` borra antes de escribir:
`authorization`, `cookie`, `x-spike-key`, `password`, `token`, `accessToken`,
`refreshToken`, `apiSecret`, `cardToken`, `cardNumber`, `cvv`, `securityCode`,
`docNumber`, `phoneE164`, `deliveryCode`, `card_number`, `security_code`,
`first_six_digits`, `cardholder`. Verificado por
`test/unit/logger-redaction.spec.ts`.

**Aislamiento** — la pertenencia va en el `WHERE`, nunca en un `if` posterior.
Un recurso ajeno devuelve 404, no 403: un 403 confirma que existe.

---

## 11 · Formulario de Seguridad de los datos de Google Play

Lo que hay que declarar, ya traducido a las categorías de Google.

| Categoría | ¿Se recopila? | ¿Se comparte? | Obligatorio | Para qué |
|---|---|---|---|---|
| Nombre | Sí | Sí, con el vendedor | Sí | Funcionalidad de la app |
| Correo electrónico | Sí | Sí, con Mercado Pago | Sí | Funcionalidad, gestión de la cuenta |
| Teléfono | Sí | Sí, con el vendedor | No (sí para comprar) | Funcionalidad |
| Dirección | Sí | Sí, con el vendedor | No (sí para comprar) | Funcionalidad |
| Otros datos personales (DNI, fecha de nacimiento) | Sí | No | No (sí para comprar o vender) | Funcionalidad, cumplimiento legal |
| Historial de compras | Sí | No | Sí | Funcionalidad |
| Información de pago | **No** | — | — | La procesa Mercado Pago |
| Fotos | Sí | No | No | Sólo las que subís a tu tienda |
| Audio y video | **No se recopilan** | — | — | Los vivos no se graban |
| Mensajes en la app | Sí | No | No | Funcionalidad y moderación |
| Actividad en la app | Sí | No | No | Funcionalidad |
| Historial de búsqueda | **No** | — | — | |
| Ubicación | **No** | — | — | |
| Contactos | **No** | — | — | |
| Registros de fallos y diagnóstico | Sí | No | No | Sólo en nuestros servidores |
| Identificadores del dispositivo | Sí | No | No | Gestión de sesiones y seguridad |

**Prácticas de seguridad a declarar:**

- Los datos se cifran en tránsito: **sí**.
- Se puede pedir la eliminación de los datos: **sí** →
  `https://vendox.com.ar/eliminar-cuenta`
- Cumple con la política de Familias: **no aplica** (la app es 18+).

---

## 12 · Huecos detectados

Lo que esta auditoría encontró y todavía no está resuelto.

1. **Push no llega a ningún teléfono.** El backend está completo y la app no
   registra el token. El choque de paquetes ya se resolvió —el `applicationId`
   es `com.vendox.app` desde el 15/08/2026, igual que en Firebase— así que
   falta bajar el `google-services.json`, agregar `firebase_messaging` y pasarle
   el token a `loginConGoogle`, que ya lo acepta.
2. **`privacidad@vendox.com.ar` no existe todavía.** Las dos páginas lo publican
   como canal de contacto.
3. **Sin purga automática** para `auth_events`, `notifications` ni `reports`. La
   política no promete un plazo para estos, así que no hay contradicción — pero
   crecen sin techo.
4. **`SENTRY_DSN` es una variable muerta.** O se implementa o se saca de
   `env.schema.ts`: una variable que sugiere que mandamos errores a un tercero
   cuando no lo hacemos confunde la próxima auditoría.
