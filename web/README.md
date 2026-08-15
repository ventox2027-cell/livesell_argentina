# web/ — las páginas públicas de vendox.com.ar

Dos páginas HTML estáticas, sin build, sin dependencias y sin JavaScript.

```
web/
├── privacidad/index.html       → https://vendox.com.ar/privacidad
└── eliminar-cuenta/index.html  → https://vendox.com.ar/eliminar-cuenta
```

Google Play exige las dos URLs y las verifica: la de privacidad para la ficha de
la app, y la de eliminación de cuenta como requisito aparte, que se declara en
**Play Console → Contenido de la app → Eliminación de datos**.

## Por qué HTML plano

Estas dos páginas tienen que estar arriba el día que un revisor de Google las
abra, y ese día puede caer cualquier semana. Un framework agrega un paso de
compilación, un `node_modules` y una versión que se rompe sola con el tiempo,
todo para servir dos documentos de texto que casi no cambian.

Cada archivo se abre en un navegador tal cual está, sin servidor.

## Cómo se publican

**No están publicadas todavía.** Ni el DNS ni el hosting se tocaron: eso lo
decide y lo ejecuta una persona.

La opción natural es **Cloudflare Pages**, porque el dominio y el
almacenamiento de imágenes (R2) ya están en Cloudflare y no cuesta nada:

1. Cloudflare Dashboard → Workers & Pages → Create → Pages.
2. Conectar el repositorio.
3. Build command: *(vacío)*. Build output directory: `web`.
4. Custom domain: `vendox.com.ar`.

Cualquier hosting estático sirve igual. Lo único que importa es que
`/privacidad` y `/eliminar-cuenta` respondan 200 sin redirecciones raras —
Google verifica la URL exacta que se declara en la ficha.

Si el hosting no resuelve `carpeta/index.html` automáticamente, hay que activar
esa opción o renombrar los archivos a `privacidad.html` y `eliminar-cuenta.html`
y cambiar las URLs declaradas.

## Antes de publicar

- [ ] Que `privacidad@vendox.com.ar` **exista y alguien lo lea**. La página
      promete respuesta en 10 días corridos, que es lo que fija la Ley 25.326.
- [ ] Revisar el domicilio legal en la sección 1 de la política.

## Al cambiar el contenido

La fecha de «Última actualización» de cada página es a mano. Si cambia algo de
fondo, hay que moverla.

Y antes de tocar la política de privacidad, leer
[`docs/PRIVACIDAD-AUDITORIA.md`](../docs/PRIVACIDAD-AUDITORIA.md): tiene el
inventario campo por campo del que salió cada afirmación de esa página. Si el
código cambia y el inventario no, la política empieza a mentir.
