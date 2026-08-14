# Imágenes: Cloudflare R2

Cómo se guardan, se sirven y se borran las imágenes de producto.

## Lo esencial

| | |
|---|---|
| Desarrollo | disco (`./storage`), servido por `@fastify/static` en `/media` |
| Staging y producción | Cloudflare R2, bucket `vendox-products`, São Paulo |
| Se elige con | `STORAGE_DRIVER=local\|r2` |
| El bucket | **privado**, y así se queda |
| La app móvil | no sabe que Cloudflare existe |

---

## El problema que definió el diseño

El bucket es privado y todavía no hay dominio propio. Lo obvio sería guardar
URLs firmadas en la base. **Eso rompe el historial de pedidos.**

`OrderItem.imageUrlSnapshot` es un registro histórico: la foto que el comprador
vio cuando compró. Se guarda a propósito, porque si el vendedor después cambia
o borra la imagen, el pedido tiene que seguir mostrando lo que se compró.

Una URL firmada vence. Guardarla ahí es sembrar imágenes rotas a plazo fijo: a
los cinco minutos, el historial de pedidos de todo el mundo se vacía solo — y
nada lo avisa hasta que alguien abre una compra vieja.

Lo mismo, en menor grado, con `ProductImage.url`.

### La salida: URL estable que redirige a una firmada

```
teléfono → GET https://api.vendox.ar/media/products/prd_01ABC/<uuid>.webp
                                    │
                                    ↓  el backend firma en el momento
                              302 Location: https://…r2…?X-Amz-Signature=…
                                    │
teléfono → GET Cloudflare ──────────┘   los bytes van directo, sin pasar por la API
```

Cuatro propiedades:

1. **Lo que se persiste no caduca.** La base guarda `/media/<clave>`, que vale
   para siempre.
2. **El bucket sigue cerrado.** Sin firma no se baja nada, y las firmas duran
   cinco minutos.
3. **Los bytes no pasan por la API.** Lo que sale del backend son unos cientos
   de bytes de cabecera. Como proxy, cada foto de cada producto de cada scroll
   ocuparía una conexión de Node mientras se transfiere.
4. **Se puede migrar sin tocar la base.** Cuando exista el dominio, las URLs
   nuevas van directas al CDN y las viejas siguen andando por la redirección.

### Cuando llegue el dominio

Se configura `R2_PUBLIC_BASE_URL` y listo. Las imágenes nuevas se guardan con
la URL directa; las viejas siguen redirigiendo. **No hay migración.**

---

## Variables

```
STORAGE_DRIVER=r2
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
R2_BUCKET=vendox-products
R2_ACCOUNT_ID=
R2_PUBLIC_BASE_URL=          # vacío hasta que exista dominio
R2_SIGNED_URL_TTL_S=300
```

El proceso **no arranca** si:

- `STORAGE_DRIVER=r2` y falta alguna de las cuatro credenciales — si no, la app
  funcionaría entera y sólo fallaría cuando un vendedor sube su primera foto;
- `STORAGE_DRIVER=local` fuera de desarrollo — el disco del contenedor no se
  comparte entre instancias y se borra al apagarse.

### Cargarlas en el proveedor

```powershell
# IBM Code Engine
ibmcloud ce secret create --name vendox-r2 `
  --from-literal "R2_ACCESS_KEY_ID=..." `
  --from-literal "R2_SECRET_ACCESS_KEY=..." `
  --from-literal "R2_ENDPOINT=https://....r2.cloudflarestorage.com" `
  --from-literal "R2_BUCKET=vendox-products"
```

Y en la app: `--env-from-secret vendox-r2 --env STORAGE_DRIVER=r2`.

---

## Verificar el bucket antes de desplegar

Desde `backend/`:

```powershell
$env:CHECK_R2_ENDPOINT="https://<cuenta>.r2.cloudflarestorage.com"
$env:CHECK_R2_ACCESS_KEY_ID="..."
$env:CHECK_R2_SECRET_ACCESS_KEY="..."
$env:CHECK_R2_BUCKET="vendox-products"
npm run check:conexiones
```

Sube un PNG de prueba, firma una URL, la descarga **sin credenciales**,
comprueba que el bucket rechace el acceso sin firma, y borra el objeto.

Escribe de verdad a propósito. Un token de sólo lectura pasa cualquier
comprobación pasiva y falla recién cuando alguien sube una foto; uno que escribe
pero no borra no se nota nunca, sólo va acumulando objetos huérfanos pagos.

**No imprime ninguna credencial.** La salida se puede pegar en un chat.

---

## Claves de objeto

```
products/<productId>/<uuid>.<ext>
```

- El **UUID lo genera el backend**. El `filename` del cliente no se usa jamás
  como ruta: un `../../../etc/passwd` escribiría fuera de la carpeta, y uno que
  colisione pisaría la imagen de otro vendedor.
- La **extensión sale del tipo real**, detectado por los primeros bytes del
  archivo (números mágicos), no del `content-type` declarado ni del nombre.
- El `Content-Type` que se guarda es ese mismo tipo real. Un archivo guardado
  como `text/html` y servido desde nuestro dominio sería XSS almacenado.
- Como cada subida tiene UUID propio, los objetos son inmutables y se cachean
  un año.

Al leer, `/media/<clave>` valida contra una expresión estrecha antes de firmar
nada. Todo lo que no tenga exactamente esa forma da **404**, sin decir por qué:
un mensaje distinto para "mal formada" y para "no existe" le confirma a quien
prueba cuándo acertó la forma.

---

## Borrado

1. Se borra la fila dentro de una transacción y se compactan las posiciones.
2. **Después** de cometer, se borra el objeto en R2.

El orden importa: al revés, un fallo de base dejaría la fila apuntando a un
archivo que ya no existe, y la app mostraría una imagen rota.

**El borrado en R2 no lanza.** Para ese momento la imagen ya no existe para
nadie. Propagar el error haría que el vendedor viera "no se pudo borrar" cuando
sí se borró — volvería a intentarlo, no la encontraría, y no entendería nada.

Lo que queda es un objeto huérfano. Cuesta storage, no corrección, y **no queda
en silencio**: se registra con nivel `error` incluyendo el `storageKey`, y se
cuenta en `storage_delete_failed_total`.

> **Deuda conocida.** No hay barrido que limpie huérfanos. Se acumulan sólo
> cuando R2 rechaza un borrado, que debería ser raro. La métrica existe para
> poder alertarlo; el barrido se escribe si el contador se mueve.

---

## Métricas

```
storage_upload_total
storage_upload_failed_total
storage_delete_total
storage_delete_failed_total
storage_bytes_uploaded_total
```

Sin etiquetas variables. Prometheus crea una serie por combinación de
etiquetas: poner el `storageKey` o el id del producto haría explotar la memoria
del servidor de métricas. Eso va en los logs, que sí toleran cardinalidad alta.

---

## Qué NO se hace

- **No se habilita la "Public Development URL" de Cloudflare.** Un bucket
  público es un bucket enumerable: quien tenga la URL base puede listar y bajar
  todo, hoy y en el futuro, incluido lo que alguien suba por error.
- **Flutter no conoce ninguna credencial de R2.** Manda la imagen al backend y
  recibe una URL. No sabe que Cloudflare existe.
- **Nunca se borra por URL recibida del cliente.** Siempre por el `storageKey`
  persistido.
- **Los errores que ve el cliente no dicen quién guarda los archivos.** Saber
  qué proveedor hay detrás es el primer paso para buscarle vulnerabilidades
  conocidas.

---

## Migrar imágenes existentes

**No hace falta hoy.** Las que hay son de desarrollo, en el disco de la
notebook, y staging está vacío.

Si algún día hiciera falta, el procedimiento es: leer las filas de
`ProductImage`, subir cada archivo de `./storage/<storageKey>` a R2 con la misma
clave, y actualizar `url` con `urlPublica(storageKey)`. La clave no cambia, que
es justamente por qué se guarda separada de la URL.

---

## Detalle conocido de las URLs firmadas

Una URL prefirmada de S3 incluye el `X-Amz-Credential`, que contiene el **access
key ID** — no el secreto. Es así por diseño de la firma AWS v4 y no permite
hacer nada por sí solo: sin el secreto no se puede firmar otra petición.

Aun así es información que se filtra, y desaparece cuando exista el dominio
público, porque entonces no habrá firmas en las URLs.
