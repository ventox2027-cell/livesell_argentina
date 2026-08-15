# Informe final — cola de producción

15 de agosto de 2026 · desde `8fe7c2e` hasta `909b42f`

Trece commits. Nueve bloques de la cola prioritaria, cerrados y verificados.

---

## 1 · Lo que se hizo, en una tabla

| # | Bloque | Commit |
|---|---|---|
| 1 | Firebase/FCM real + cuenta de revisión para Google Play | `8c9c292` |
| 2 | Bloqueo de personas | `1045ffc` |
| 3 | Moderación real del chat del vivo | `ddfc3d0` |
| 4 | Reportar desde todos lados + panel de moderación + política UGC | `0d98544` |
| 5 | Privacidad web + auditoría de datos + cierre de cuenta | `c581c8e` |
| 6 | Categorías de producto, obligatorias al publicar | `597e350` |
| 7 | Seguridad de entorno + escáner de secretos | `b45dbc0` |
| 8 | Cuatro interruptores de emergencia | `f7037b5` |
| 9 | Los veinte invariantes de negocio | `e1b0777` |
| — | La auditoría del bloqueo no se esperaba | `10dfd7e` |
| — | `BETA_READINESS.md` y `PRODUCTION_GAPS.md` | `909b42f` |

---

## 2 · Los tres agujeros reales que aparecieron

No estaban en la lista de tareas. Aparecieron auditando, y son la parte de este
trabajo que más importa.

### El cierre de cuenta dejaba el DNI

Cerrar la cuenta anonimizaba el `User` —nombre, correo, teléfono, fecha de
nacimiento— y dejaba `user_addresses` intacta: **DNI completo, teléfono, calle,
número, piso y departamento** de la casa de alguien que pidió irse.

Anonimizar la fila que apunta y no la que tiene los datos no anonimiza nada. Y
un `deletedAt` no alcanzaba: la fila sigue ahí con todo adentro y lo único que
cambia es qué consultas la traen.

Ahora se vacían los campos. Las órdenes viejas no se rompen porque no apuntan a
esa tabla: llevan su propia copia en `shipping_address`, que es el comprobante
de a dónde se mandó algo que ya se mandó.

### La UI de desarrollo viajaba en la APK

Tres cosas: las herramientas de medición del Sprint 0, la URL del backend a la
vista, y **«Configurar servidor»** — un botón que apunta la app al servidor que
uno quiera. En el teléfono de otra persona, eso es redirigirla a un servidor
propio y ver pasar sesiones, direcciones y pedidos.

Y el manifiesto tenía `usesCleartextTraffic="true"` para toda la app. Su propio
comentario decía que no debía existir en el producto.

### La auditoría del bloqueo no se escribía

`void this.audit.log(...)` devolvía la respuesta antes de que la fila existiera.
El test que la cuenta fallaba una de cada tres corridas completas — y lo
estábamos tratando como un test flaky.

No lo era. En producción significa que un bloqueo puede responder OK y no quedar
registrado nunca. La secuencia de bloqueos es la mitad de la historia cuando
alguien denuncia acoso.

---

## 3 · Lo que se comprobó sobre la APK real

No leyendo código: abriendo el binario.

| Verificación | Resultado |
|---|---|
| `Herramientas del Sprint 0` en `libapp.so` | **ausente** |
| `Configurar servidor` | **ausente** |
| `Medición de LiveKit` | **ausente** |
| `Comprá mientras lo estás viendo` (control positivo) | presente |
| `Política de privacidad` y la URL | presente |
| `Elegí un rubro antes de publicar` | presente |
| `usesCleartextTraffic` en el manifiesto | **ausente** |
| `networkSecurityConfig` en el manifiesto | presente |
| La política restrictiva compilada (`res/8G.xml`) | presente, con `base-config` y `10.0.2.2` |
| Escaneo de secretos, 105 entradas | 0 hallazgos |

Además: al hornear un `--dart-define=SPIKE_API_KEY=…` en una compilación de
release, **el valor no aparece en el binario**. Nada lo lee, así que el
compilador lo borró junto con las pantallas del spike. Es la prueba de que la
bandera de compilación hace lo que dice.

### Las APKs

| Archivo | Tamaño |
|---|---|
| `app-arm64-v8a-release.apk` | 33,9 MB |
| `app-armeabi-v7a-release.apk` | 26,8 MB |
| `app-x86_64-release.apk` | 39,1 MB |

En `mobile/build/app/outputs/flutter-apk/`.

⛔ **Firmadas con la clave de debug.** Sirven para instalar en teléfonos propios.
No se pueden publicar. Ver el hueco 1 de
[`PRODUCTION_GAPS.md`](PRODUCTION_GAPS.md).

---

## 4 · Números

| | Antes | Ahora |
|---|---|---|
| Tests de backend | 1053 | **1286** |
| Tests de la app | 183 | **242** |
| Archivos de test (backend) | — | 57 |
| Migraciones nuevas | — | 2 |

Lint, typecheck y `flutter analyze` limpios en las tres bases de código. Cinco
corridas completas seguidas del backend en verde después del arreglo de la
carrera.

---

## 5 · Verificación por sabotaje

Cada regla nueva se rompió a propósito para confirmar que algún test la ve.

| Sabotaje | Tests que fallan |
|---|---|
| Comisión sobre el total en vez del producto | 1 |
| WHERE de la reserva sin comparar cantidad | **0** — lo ataja el CHECK |
| Ese WHERE roto **más** el CHECK borrado | 1 |
| Quitar `buyerId` del WHERE de la orden | 1 |
| La regla de publicar no exige categoría | 3 |
| Mirar `dto.status` en vez del estado resultante | 1 |
| No validar que la categoría exista | 2 |
| No vaciar la dirección al cerrar la cuenta | 1 |
| Quitar la condición de «Configurar servidor» | 1 |
| Quitar la condición de la sección de desarrollo | 2 |
| El enlace a la política vuelve a ser texto plano | 1 |
| Renombrar la carpeta `web/privacidad` | 1 |
| La bandera de emergencia no frena nada | 7 |
| La bandera **además** frena las órdenes en curso | 1 |
| Las banderas por defecto en `false` | 1 |

El segundo caso es el más interesante y por eso está en la tabla con un cero: el
sistema aguanta con una de las dos capas rota. Para eso existe la segunda.

---

## 6 · Decisiones que se tomaron

Cada una con su motivo, para que no haya que reconstruirlo después.

**Las categorías son una lista plana de catorce, no un árbol.** Un árbol obliga
a navegar «Indumentaria → Mujer → Calzado → Zapatillas» para cargar un producto,
y a adivinar en qué rama quedó para encontrarlo. `parent_id` sigue en la tabla
para el día que una categoría sea tan grande que haya que partirla.

**Sus ids son legibles** (`cat_calzado`, no `cat_01J…`). Es un catálogo fijo que
tiene que existir igual en los tres entornos: con ids deterministas la semilla es
idempotente sin consultar nada, y un id en un log dice lo que es.

**La categoría se exige al publicar, no al crear.** Mismo criterio que Mercado
Pago: quien se sienta a cargar cuarenta productos los carga, y recién al final
completa lo que falta.

**Las banderas de emergencia son variables de entorno, no una tabla con un
botón.** El botón apagaría más rápido —un clic contra unos segundos de
reinicio— y sería un segundo mecanismo de configuración conviviendo con el que
ya existe. En una emergencia, que «¿por qué no anda el checkout?» tenga dos
lugares donde buscar cuesta más que los segundos que ahorra.

**Las herramientas internas se controlan por compilación, no por
configuración.** Tiene que ser una constante para que el compilador elimine el
código; si viniera del servidor, un backend mal apuntado podría encenderlas.

**Las páginas públicas son HTML plano.** Tienen que estar arriba el día que un
revisor de Google las abra. Un framework agrega un paso de compilación y un
`node_modules` para servir dos documentos de texto que casi no cambian.

**El escáner de secretos mira sólo lo versionado.** Recorrer el disco marcaba
`backend/.env` en cada corrida —el archivo donde los secretos tienen que
estar— y veinte cadenas de conexión a localhost. Un escáner con hallazgos
permanentes en lugares correctos es un escáner que se ignora.

---

## 7 · Lo que NO se hizo, y por qué

**No se tocó el `applicationId`.** Está prohibido sin autorización explícita. Es
el que choca con la app de Firebase (`com.vendox.app`), y por eso el push todavía
no llega a ningún teléfono. Necesita una decisión, no código: hueco 5 de
`PRODUCTION_GAPS.md`.

**No se generó la clave de firma.** Es irreversible y hay que hacerlo con vos
presente: si se pierde, no se puede volver a publicar una actualización nunca.

**No se publicó nada.** Ni DNS, ni hosting, ni Play Store. Las páginas están
escritas y listas en `web/`.

**No se encendió R8.** Puede romper plugins en tiempo de ejecución, de una forma
que no se ve compilando, y no se puede probar sin un teléfono.

**No se declaró Sentry en la política de privacidad.** La variable existe, el
paquete no está instalado y nadie la lee. Documentado como variable muerta.

---

## 8 · Lo que sigue

En orden.

1. **Decidir el `applicationId`.** Bloquea el push y no se puede cambiar después
   de publicar.
2. **Generar la clave de subida** y agregar el cliente de OAuth de Android nuevo
   en Google Cloud — eso último es lo que se olvida y rompe el login con Google.
3. **Crear `privacidad@vendox.com.ar`** y publicar las dos páginas.
4. **Correr la cuenta de revisión** y encender `DEMO_LOGIN_ENABLED`.
5. **Beta cerrada**, con las banderas de emergencia a mano.

La lista completa, con quién puede cerrar cada cosa, está en
[`PRODUCTION_GAPS.md`](PRODUCTION_GAPS.md).
