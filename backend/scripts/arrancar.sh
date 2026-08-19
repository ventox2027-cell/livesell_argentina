#!/bin/sh
# Arranque del contenedor: migrar y después servir.
#
# ═══════════════════════════════════════════════════════════════════════════
# POR QUÉ UN SCRIPT Y NO UN COMANDO ENCADENADO
# ═══════════════════════════════════════════════════════════════════════════
#
# La alternativa es poner esto en un campo de texto de la plataforma:
#
#     prisma migrate deploy && node dist/main.js
#
# Se probó en Railway y el resultado fue un despliegue mudo: las migraciones
# corrieron, Nest nunca arrancó, y como el proceso salió con código 0 la
# plataforma lo marcó «Completed» y no lo reinició. Un servidor caído sin un
# solo error en ningún log.
#
# Nunca quedó claro si el problema fue el encadenado o la falta de healthcheck,
# y esa es justamente la razón de este archivo: un comando que vive en la
# configuración de un proveedor no se puede leer, ni versionar, ni probar. Éste
# viaja en la imagen, se revisa en un diff y se ejecuta igual en cualquier lado.
#
# ═══════════════════════════════════════════════════════════════════════════
# QUÉ HACE DISTINTO
# ═══════════════════════════════════════════════════════════════════════════
#
# `set -e` corta ante el primer error. Sin eso, una migración fallida dejaría
# arrancar la API contra un esquema a medias — que es peor que no arrancar: el
# servidor responde 200 en /health y rompe en cada consulta.
#
# Y `exec` reemplaza el proceso del shell por Node, en vez de dejarlo como
# padre. Así Node vuelve a ser el PID 1 y recibe SIGTERM directo. Con un shell
# en el medio, la señal no se reenvía: el proceso no se entera del apagado,
# sigue atendiendo hasta el SIGKILL, y cada despliegue corta peticiones a la
# mitad. Con pagos en vuelo, eso es plata.

set -e

# ═══════════════════════════════════════════════════════════════════════════
# ANTES DE MIGRAR: ¿por dónde vamos a migrar?
# ═══════════════════════════════════════════════════════════════════════════
#
# `migrate deploy` toma un lock de sesión. Si la conexión pasa por un agrupador
# —PgBouncer en modo transacción, que es lo que da Neon en `-pooler`— no hay
# sesión que lo sostenga: el lock se toma en un backend y la consulta siguiente
# pregunta en otro. Diez segundos después:
#
#     P1002  Timed out trying to acquire a postgres advisory lock
#
# Ese mensaje no menciona el pooler por ningún lado, así que el despliegue muere
# apuntando al lugar equivocado. Pasó dos veces.
#
# Esto lo dice antes, en una línea, y corta acá. También imprime el host —sin
# credenciales— para que en los logs quede constancia de por dónde se migró.
node dist/revisar-conexion.js

echo "→ Aplicando migraciones pendientes…"
node_modules/.bin/prisma migrate deploy

echo "→ Migraciones al día. Arrancando la API…"
exec node dist/main.js
