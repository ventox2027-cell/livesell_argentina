# VendoX — Informe de la primera cola de trabajo

**Fecha:** 14 de agosto de 2026
**Rama:** `master`
**Desde:** `8fe7c2e` · **Hasta:** `a525fda`

---

## 0. Resumen en una pantalla

La **primera cola está completa**: los doce bloques que pediste, en tu orden de
prioridad. Las colas segunda y tercera están **sin empezar**, salvo la Fase A de
la segunda (notificaciones), que hice porque la intención de compra la
necesitaba y no tenía sentido hacerla dos veces.

| | |
|---|---|
| Commits nuevos | **11** |
| Tests backend | 789 → **952** (+163) |
| Tests Flutter | 131 → **166** (+35) |
| Migraciones | **11**, todas aplicadas a desarrollo y a tests |
| Lint / typecheck / analyze | limpios |
| Repo | verde |

**Nada está desplegado.** No toqué Railway, no publiqué APK, no cambié DNS, no
compré nada, no creé credenciales.

---

## 1. Los once commits

| Commit | Qué |
|---|---|
| `075147d` | Transmitir desde el celular (broadcaster + adaptador Redis) |
| `ba8afac` | El chat del vivo se congelaba en hardware real |
| `48656c8` | El vendedor crea talles y colores desde la app |
| `c0409a0` | Código de entrega |
| `355e3f4` | Calificar la compra |
| `c34ad55` | Envío manual, comisión 6 %, costo del procesador |
| `9a7d18e` | Notificaciones, interesados y reapertura de tienda |
| `de9fdd0` | Cambios y devoluciones con el piso legal argentino |
| `6887274` | Todo eso, en la app |
| `9c7d0f2` | OAuth de marketplace con Mercado Pago |
| `af27760` | Soporte con asistente y escalada obligatoria |
| `a525fda` | Me gusta y compartir |

---

## 2. La cola, bloque por bloque

| # | Bloque | Estado |
|---|---|---|
| 1 | Broadcaster móvil | ✅ |
| 2 | Bug del chat en hardware | ✅ |
| 3 | Variantes del vendedor | ✅ |
| 4 | UI de reseñas | ✅ |
| 5 | Intención cerrada + aviso | ✅ |
| 6 | Código de entrega | ✅ |
| 7 | Envío y políticas | ✅ |
| 8 | Modelo de costo del procesador | ✅ |
| 9 | MP Marketplace OAuth + 6 % | ✅ (falta cargar credenciales) |
| 10 | Soporte foundation | ✅ (falta credencial de IA) |
| 11 | Likes + share foundation | ✅ (falta la página web) |
| 12 | Adaptador Redis del realtime | ✅ |

---

## 3. Migraciones

Once, todas con CHECK donde la regla tenía que sobrevivir a un bug del código:

| Migración | Qué protege la base |
|---|---|
| `delivery_code` | rango de intentos, formato de 6 dígitos |
| `envio_y_costo_procesador` | monto coherente con el modo de envío |
| `recargo_procesador` | recargo no negativo |
| `pickup_selected` | retiro ⇒ envío cero |
| `total_con_recargo` | el total = suma de sus cuatro partes |
| `notificaciones` | texto no vacío, intentos acotados |
| `reapertura_de_tienda` | — |
| `politicas_de_cambio` | **mínimo 10 días de arrepentimiento**, envío de vuelta del vendedor |
| `oauth_mercadopago` | refresh token completo o ausente, pista corta |
| `soporte` | escalado ⇒ motivo, mensajes no vacíos |
| `me_gusta` | contadores no negativos |

Dos herramientas nuevas para operarlas:

- `pnpm db:apply <migración>` — la aplica a desarrollo **y** a tests, y la
  registra con el checksum correcto.
- `pnpm db:generate` — `prisma generate` cuando otro proceso tiene tomado el
  motor (pasa en esta máquina, ver §11).

---

## 4. Dinero: cómo quedó el modelo

El total de un pedido tiene **cuatro partes** y cada una sale de una regla
distinta:

```
producto  +  envío  +  recargo del medio de pago  −  descuento
```

**Comisión de VendoX: 6 % sobre el producto.** No sobre el envío ni sobre el
recargo. El envío es plata que el vendedor le entrega al correo y el recargo
existe para cubrir lo que Mercado Pago le descuenta: cobrarle 6 % encima de los
dos sería cobrarle por gastar.

**Costo del procesador: base = producto + envío.** Esa base la define Mercado
Pago, que cobra sobre todo lo que pasa por él. El vendedor elige si lo absorbe o
lo traslada; si lo traslada, el recargo queda **cerrado antes de pagar** y una
diferencia posterior la absorbe él.

Hay un test que dice explícitamente que cambiar la base de la comisión **no es
corregir un cálculo, es cambiar el modelo de negocio**.

Cada orden guarda la foto de la política con la que se cobró. Cambiarla hoy no
le cambia el total a nadie que ya compró.

---

## 5. Envío

Cuatro modos: gratis, precio fijo, sólo retiro, o envío con opción de retiro.

Lo único que aporta quien compra es `retiraEnPersona`, y **el backend sólo lo
respeta si la tienda ofrece retiro**. En una tienda con precio fijo, mandar
`true` no evita el costo — sería un campo del cuerpo que hace despachar un
paquete que nadie pagó.

`pickupSelected` es una columna propia y no se deduce de `shippingAmount == 0`:
hay tiendas con envío gratis, y confundirlas hace que alguien espere en su casa
un paquete que tiene que ir a buscar.

En la app: cuando hay dos opciones se muestran **las dos con su precio al lado**,
no un interruptor. Un interruptor obliga a tocarlo para ver cuánto se ahorra.

---

## 6. Cambios y devoluciones: el piso legal

En Argentina toda compra a distancia tiene **10 días corridos de
arrepentimiento desde la entrega**, sin causa y sin costo (ley 24.240 art. 34 y
art. 1110 CCyC; Res. 424/2020 pide el botón visible).

El vendedor puede ofrecer más. **Menos, no.** "No se aceptan devoluciones" es
una cláusula nula, y publicarla nos hace responsables a nosotros también.

Tres capas, cada una cubriendo un camino que las otras no ven:

- Zod cubre el endpoint;
- `politicas.ts` cubre cualquier otro llamador del backend;
- un CHECK cubre un `UPDATE` a mano en una consola de producción.

El texto que ve el comprador **lo arma el backend**, para que diga lo mismo en
la app, en el detalle del pedido y en el mail. Ante una diferencia, la que vale
legalmente es la más favorable al comprador: siempre perderíamos.

> ⚠️ **Esto no es asesoramiento legal.** Los textos tienen que pasar por un
> abogado antes de producción. Lo que garantiza el código es que el piso exista
> y no se pueda configurar por debajo.

---

## 7. Notificaciones

Escribir el aviso y mandarlo son **dos cosas**. `crear()` escribe una fila y
vuelve: se puede llamar desde adentro de la transacción que despacha un pedido
sin que un timeout de Google lo revierta. Un barrido aparte manda los
pendientes.

El centro de notificaciones dentro de la app **no depende del push**. La mayoría
de la gente los tiene apagados; un sistema que sólo mande push no le avisa nada
a la mayoría de sus usuarios.

No hay endpoint para crear un aviso: sería una forma de mandarle notificaciones
a cualquier usuario desde la app.

Sin Firebase configurado, las filas quedan en `SKIPPED`, **no en `SENT`**.
Marcarlas como enviadas sería mentirle a la base: el día que se conecte, nadie
sabría cuáles salieron.

---

## 8. Intención de compra: las dos mitades que faltaban

**Reabrir no es un evento.** Que una tienda esté abierta se calcula con el
horario y la hora; nadie aprieta un botón a las nueve de la mañana. Sin algo que
mire el reloj, la gente que dejó "avisame cuando abran" no se entera nunca.

`StoreSchedule.wasOpen` guarda el último estado y convierte el cálculo en una
transición. Arranca en `true` a propósito: con `false`, la primera corrida vería
una reapertura falsa en **todas** las tiendas.

Contra el aviso duplicado hay dos defensas: un `UPDATE` condicional y una clave
de deduplicación con índice único.

**La lista de interesados no tiene datos de contacto.** Nombre de pila y
números. Quien dejó una intención pidió que le AVISEN; no le dio su teléfono a
un vendedor para que lo contacte por WhatsApp — que es lo que pasaría el primer
día. Hay un test que busca teléfono, email y apellido sobre el JSON entero de la
respuesta.

---

## 9. Mercado Pago Marketplace

La plata de una venta es del **vendedor**. Si entrara a una cuenta de VendoX y
después se la girásemos, estaríamos operando como entidad de pago y con dinero
de terceros en nuestro balance.

**El token nunca pasa por Flutter.** El intercambio del código por el token
necesita el `client_secret`; si lo hiciera la app, ese secreto estaría en el APK
—que se descompila en dos minutos— y cualquiera podría hacerse pasar por VendoX.

La autorización se abre en el **navegador del sistema**, no en un WebView.
Mercado Pago pide la contraseña ahí adentro; en una vista que controlamos
nosotros, el vendedor no tiene forma de saber que no la estamos leyendo.

**El `state` es la autenticación del callback.** El callback lo invoca el
navegador y no lleva sesión. Sin `state`, un atacante autoriza con SU cuenta, se
queda con el código, y hace que la víctima visite la URL: la tienda de la
víctima queda cobrando a la cuenta del atacante.

**Los tokens se cifran** con AES-256-GCM, con la llave fuera de la base. No es
un gestor de secretos —eso sigue siendo el destino— pero un volcado de la base,
por sí solo, no sirve para nada. Desconectar los **borra**, no los marca.

---

## 10. Soporte

**La IA no decide nada sobre plata. Nunca.** `PAGOS` y `DISPUTA` escalan
siempre. Hay palabras que escalan aunque la categoría no lo exija. Pedir hablar
con una persona se respeta sin excepciones.

**Primero se decide si escala, después se contesta.** Un asistente que genera la
respuesta y después mira si debía escalar ya escribió algo que no le
correspondía.

El agente es reemplazable; las reglas no. `SupportService` depende de una clase
abstracta: conectar un modelo de lenguaje es agregar una clase y cambiar una
línea. Lo que **no** cambia con esa línea es la política de escalada, que vive
afuera. Con las reglas adentro del prompt, cambiar de proveedor significaría
reescribirla y probarla de nuevo.

Y hay una red: una respuesta que promete algo prohibido —"te devolvemos",
"garantizo"— no se guarda y el ticket escala.

---

## 11. Cosas que arreglé de paso

| Qué | Por qué importaba |
|---|---|
| `verificarCoherencia` y el CHECK del total seguían con la fórmula de tres partes | Toda orden de una tienda que trasladara el costo del procesador era rechazada con "no pudimos calcular el total de tu compra" |
| El gateway del vivo cerraba Redis **antes** que Socket.IO | 40 rechazos no manejados y `vitest` terminando con código 1 con 818 pruebas en verde. En producción, excepciones sueltas justo cuando el proceso está drenando |
| `SUPPORT_TICKET_NOT_FOUND` devolvía 400 | La app mostraba "algo salió mal" donde correspondía "no existe" |
| El `ExpansionTile` de políticas sin `Material` propio | Su onda al tocar era invisible: en el teléfono se siente como que la app se colgó |
| `dart format` cortaba en 80 y el proyecto está a ~100 | Formatear un archivo lo dejaba distinto del resto. Queda declarado en `analysis_options.yaml` |

---

## 12. Tests de contrato: la regla que se hizo cumplible

`backend/test/integration/capturar-contrato.spec.ts` arranca la aplicación de
verdad contra PostgreSQL de verdad, pide los endpoints y escribe las respuestas
tal cual salen a `test/contratos/*.json`. Los tests de Flutter leen esos
archivos.

Es la regla que salió del bug de la hoja de variantes: un test de contrato con
JSON **inventado a mano** pasaba en verde mientras la app mostraba `$0,00`.
Ahora no hay forma de escribir uno a mano sin que se note.

---

## 13. Verificación por sabotaje

No alcanza con que los tests pasen: tienen que fallar cuando el código está mal.
Rompí a propósito lo importante y comprobé que se detecta.

| Sabotaje | Tests que fallaron |
|---|---|
| Exponer teléfono y apellido en la lista de interesados | 1 |
| Avisar por productos pausados | 1 |
| Quitar la validación del `state` de OAuth | 7 |
| Guardar el token de MP en claro | 11 |
| Invertir el orden escalada/respuesta + IA prometiendo reembolso | 4 |

---

## 14. Qué podés probar ya en el teléfono

Con el backend levantado en tu red local:

1. **Transmitir en vivo** desde el celular, con bandeja de productos y producto destacado.
2. **Chat del vivo** — el bug del hardware está arreglado.
3. **Crear talles y colores** desde la app, sin perder stock al editar.
4. **Comprar con envío**: elegir envío o retiro, ver el desglose del total.
5. **Cambios y devoluciones** en la ficha del producto, con el derecho legal a un toque.
6. **Código de entrega**: el comprador lo ve, el vendedor lo pide.
7. **Calificar** la compra.
8. **Centro de notificaciones** en tu perfil.
9. **Interesados** en el panel de vendedor.
10. **Configurar envío y devoluciones** con el total de ejemplo en vivo.
11. **Me gusta** en el vivo y **compartir** por WhatsApp.
12. **Soporte**: abrir un ticket y ver cómo escala si hablás de plata.

**Lo que NO podés probar todavía:** conectar Mercado Pago (faltan credenciales),
push reales (falta Firebase), y el enlace compartido abierto sin la app (falta
la página web).

---

## 15. Bloqueos externos — lo que necesito de vos

### 15.1 Credenciales de Mercado Pago Marketplace

Del panel de aplicaciones de Mercado Pago:

- `MP_CLIENT_ID`
- `MP_CLIENT_SECRET`
- `MP_OAUTH_REDIRECT_URI` → tiene que terminar **exactamente** en
  `/oauth/mercadopago/callback`, sin `/api` y sin `/v1`. El backend rechaza el
  arranque si no coincide.

**Dónde cargarlas:** en el `.env` local para probar, y en las variables del
servicio cuando despleguemos. No me las pegues en el chat.

### 15.2 Llave de cifrado

Generala y guardala:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

→ `CREDENTIALS_ENCRYPTION_KEY`

> ⛔ Si se pierde, los tokens guardados son irrecuperables y todos los vendedores
> tienen que reconectar. Si se filtra, quien la tenga puede cobrar en nombre de
> cualquier vendedor. Guardala donde guardes las cosas importantes.

### 15.3 Firebase

Para los push. Hoy los avisos quedan en el centro de notificaciones y no salen
al teléfono.

### 15.4 Proveedor de IA para soporte

Opcional: sin él, el asistente contesta con respuestas guionadas, que además son
el respaldo permanente para cuando el proveedor esté caído.

---

## 16. Decisiones que te tocan a vos

1. **¿Exigimos cuenta de MP conectada para publicar?** Hoy, si el vendedor no la
   conectó, el cobro entra en nuestra cuenta. Está así para que el sistema
   funcione durante la beta, pero **antes de abrir al público hay que decidirlo**:
   acumular ventas sin cuenta conectada significa deberle plata a gente y
   devolverla a mano. Mi recomendación: exigirla.
2. **Textos legales** — los de cambios y devoluciones tienen que pasar por un
   abogado.
3. **Quién controla la plata en una disputa** — sigue sin definirse, y es lo que
   bloquea el flujo de devoluciones completo.
4. **Precio de la membresía Pro.**

---

## 17. Deuda anotada

| Deuda | Riesgo |
|---|---|
| Cuenta de MP no conectada ⇒ cobro en nuestra cuenta | **Alto.** Ver §16.1 |
| Gestor de secretos en vez de cifrado con sobre | Medio. Quien tenga el proceso descifra todo |
| Rotación de llave manual | Bajo. `key_version` ya está para hacerla sin parar el sistema |
| Página web de los enlaces compartidos | Medio. Hoy un enlace compartido lleva a un 404 |
| El barrido de avisos no tiene candado entre procesos | Bajo. Con dos worker, un aviso duplicado. Error del lado correcto |
| Lista de palabras de escalada en vez de clasificador | Bajo y deliberado. Se reemplaza cuando haya volumen para medir |
| `Like` polimórfico sin clave foránea | Bajo. Se compensa verificando el destino antes de escribir |

---

## 18. Lo que NO está hecho

**Segunda cola** — sin empezar, salvo notificaciones (Fase A), que hice acá:

Centro de notificaciones ✅ · outbox ✅ · FCM ⛔ · Admin Lite V2 · búsqueda ·
ranking del feed · analítica del vendedor · categorías · reportes · moderación ·
endurecer checkout · snapshots de precio · políticas de tienda en UI ✅ ·
seguridad de sesión · cambios críticos del vendedor · 18+ · favoritos ·
likes ✅ · share ✅ · deep links · UX de error · offline · accesibilidad ·
performance · observabilidad · separación de workers · retención · exportación ·
borrar cuenta · draft de productos · página de tienda · onboarding · home del
vendedor · timelines · WhatsApp/email · flags · E2E · caos · staging · CI ·
runbooks · índices · carga · BETA_READINESS.md

**Tercera cola** — sin empezar. Es la de producción y despliegue, y arranca
donde termina esto.

---

## 19. Estado del repo

```
backend:  952 tests · lint limpio · typecheck limpio
mobile:   166 tests · analyze limpio
```

Todo commiteado en `master`. Nada desplegado.

---

## 20. Cómo seguir

Mi orden sugerido, si querés que siga sin parar:

1. **Cargá las credenciales de MP y la llave de cifrado** — desbloquea probar el
   cobro real en tu teléfono, que es lo único grande que falta verificar.
2. **Segunda cola desde el principio**, saltando lo que ya está hecho.
3. **Tercera cola** al final, que es la de desplegar.

Si preferís otro orden, decímelo y arranco por ahí.
