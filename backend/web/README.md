# web/ — el sitio público de vendox.com.ar

HTML estático, sin build, sin dependencias y con un solo `<script>` opcional.

```
backend/web/
├── index.html                  → https://vendox.com.ar/
├── _estilo.css                 → la identidad, compartida
├── descargar/index.html        → /descargar
├── soporte/index.html          → /soporte
├── privacidad/index.html       → /privacidad          (Google Play la exige)
└── eliminar-cuenta/index.html  → /eliminar-cuenta     (Google Play la exige)
```

## ⚠️ Por qué esto vive dentro de `backend/`

Porque **lo sirve el backend**, y porque el contexto de construcción de la
imagen Docker es `backend/`: un `COPY ../web` no existe. Con la carpeta en la
raíz del repositorio la imagen se construye igual y el sitio devuelve 404 en
producción, sin que nada falle.

## La arquitectura, y por qué es ésta

**`vendox.com.ar` y `api.vendox.com.ar` son el mismo servicio de Railway.**

Parece mezclar dos cosas. Es al revés: separarlas obligaría a mantener un proxy,
porque hay rutas del dominio público que **sólo puede contestar el backend**.

| Ruta | Por qué no puede ser un archivo |
|---|---|
| `/.well-known/assetlinks.json` | las huellas salen del entorno, no del repo |
| `/p/:id` `/v/:id` `/t/:slug` `/u/:slug` | el robot de WhatsApp no ejecuta JavaScript: las etiquetas `og:` tienen que venir escritas por el servidor |
| `/descargar/android` | es una redirección firmada a R2, con el bucket privado |

Con un hosting estático aparte —Cloudflare Pages, R2, lo que sea— esas seis
rutas necesitan reglas de proxy sincronizadas a mano con el código. Con un solo
origen, no existe la pregunta de quién sirve qué.

Y ya se despliega solo: Railway construye desde GitHub en cada push a `main`.
Cero pipelines nuevos, cero hosting nuevo, cero secretos nuevos para el sitio.

El costo es que el proceso de la API entrega cinco archivos de 40 kB. El backend
ya servía HTML en `/p/:id`.

### Lo que NO se eligió, y por qué

- **Cloudflare Pages** — el más natural a primera vista, pero R2 y Pages con
  dominio propio necesitan la zona en Cloudflare, y los nameservers se quedan en
  Donweb. Además hay que mantener el `_redirects` con las seis rutas de arriba.
- **R2 como sitio estático** — mismo problema de dominio, y encima no puede
  contestar nada dinámico.

## La descarga del APK

El botón apunta a `/descargar/android`, **siempre la misma URL**.

```
GET /descargar/android       → 302 a una URL firmada de R2 (vendox-latest.apk)
GET /descargar/android.json  → { version, commit, publicadaEl, tamanoBytes }
```

El bucket `vendox-media` sigue **privado**. Abrirlo para repartir un APK
expondría también las fotos de todos los productos, incluidas las de borradores
que sus vendedores no publicaron.

⛔ **Nunca un artefacto de GitHub Actions como URL pública.** Vencen a los
catorce días y su dirección cambia en cada corrida: el botón funcionaría dos
semanas y después devolvería 404, sin que quien lo toca pueda saber que el roto
es el botón. Los artefactos siguen existiendo para QA.

## Publicar una versión nueva

```bash
git tag v0.1.0
git push --tags
```

Eso solo dispara `.github/workflows/build-apk.yml`, que:

1. corre `flutter analyze` y los tests;
2. compila APK y AAB firmados con `API_BASE_URL=https://api.vendox.com.ar`;
3. verifica que la firma **no** sea la de depuración;
4. busca secretos en el binario;
5. sube a R2 `releases/android/v0.1.0/vendox.apk` (inmutable);
6. pisa `releases/android/vendox-latest.apk`;
7. escribe `releases/android/latest.json`.

La ficha se escribe **después** del APK a propósito: si la subida del binario
falla, la web sigue anunciando la versión anterior — que es la que
efectivamente se puede bajar.

Un push a `main` **no** compila APK: eso son minutos y un binario que nadie va a
instalar. Los tests sí corren en cada push, en `ci.yml`.

## Al cambiar el contenido

La fecha de «Última actualización» de cada página legal es a mano. Si cambia
algo de fondo, hay que moverla.

Y antes de tocar la política de privacidad, leer
[`docs/PRIVACIDAD-AUDITORIA.md`](../../docs/PRIVACIDAD-AUDITORIA.md): tiene el
inventario campo por campo del que salió cada afirmación de esa página. Si el
código cambia y el inventario no, la política empieza a mentir.

## Antes de publicar

- [ ] Que `privacidad@vendox.com.ar` **exista y alguien lo lea**. La página
      promete respuesta en 10 días corridos, que es lo que fija la Ley 25.326.
- [ ] Que `soporte@vendox.com.ar` exista.
- [ ] Revisar el domicilio legal en la sección 1 de la política.
