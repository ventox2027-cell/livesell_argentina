# Qué se hizo mientras dormías · 13/08/2026

> Todo commiteado y subido a
> [ventox2027-cell/livesell_argentina](https://github.com/ventox2027-cell/livesell_argentina).

---

## Para probar apenas te levantes

**1. Instalá el APK nuevo** desde `http://192.168.0.14:8099` (con el `http://`).

**2. Al abrir vas a ver la pantalla de bienvenida.** Tocá **"Configurar servidor"**
y pegá:

```
https://cents-researchers-spend-valuation.trycloudflare.com
```

Te va a decir "Servidor OK" si responde. Si el túnel ya murió —muere al cerrar
la terminal— avisame y levanto uno nuevo.

**3. Tocá "Entrar en modo prueba"**, poné cualquier email y entrá.

Vas a caer en el feed. Deslizá para arriba y para abajo.

**4. Andá a Perfil.** Ahí está la primera pantalla completamente funcional:
cargá tu teléfono como quieras escribirlo —`011 15 5555 6666`— y fijate que lo
guarda como `+5491155556666`.

Las herramientas del Sprint 0 siguen ahí, en **Perfil → Desarrollo**.

---

## Lo que cambió

### Sprint 0 cerrado con GO

Los dos riesgos técnicos que podían matar el proyecto quedaron respondidos con
mediciones. Detalle completo en [sprint-0/RESULTS.md](sprint-0/RESULTS.md).

| | |
|---|---|
| **R2** · latencia desde redes argentinas | p95 de **577 ms** contra un objetivo de 800 |
| **R1** · cobrar sin arrastrar el alcance PCI | **SAQ-A**, cero datos de tarjeta verificado |

### Auth: el primer módulo de producto

Backend completo, con **219 tests**. Las decisiones que vale la pena que
conozcas:

**Todo está cerrado por defecto.** El guard es global y cada endpoint pide
sesión salvo que se marque como público explícitamente. Al revés —proteger uno
por uno— el olvido queda abierto y no se ve al revisar, porque lo que falta es
una línea que no está.

**Las sesiones se pueden cortar desde el servidor.** Cada refresco quema el
token anterior; si uno ya quemado reaparece significa que hay dos copias
circulando, y como no hay forma de saber cuál es del dueño, se cortan las dos.

**El rol se lee de la base en cada petición, no del token.** Cuesta una lectura
por índice primario y compra que suspender a un estafador tenga efecto ahora y
no cuando venza su token.

**Una persona, una cuenta.** Si entrás con Google y mañana con Apple, se
vincula a la misma cuenta en vez de partirte el historial de compras en dos.

### La app dejó de ser la herramienta de medición

Ahora es el producto. Tema oscuro, feed vertical, cinco secciones, y perfil
funcionando contra el backend real.

El feed tiene **contenido de ejemplo**: la estructura está completa —vendedor,
descripción, tarjeta de producto con precio y stock, acciones laterales— y el
video llega con Live Sessions. Se hizo en ese orden a propósito: la parte
difícil de un feed de venta no es reproducir, es que en dos segundos se
entienda qué se ofrece y cuánto sale.

---

## Lo que necesito de vos

**1. Credenciales de Google** para que "Continuar con Google" funcione de
verdad. Hay que crear un proyecto en Firebase y sacar los client IDs de Android
e iOS. El backend ya verifica esos tokens: sólo falta obtenerlos.

**2. La compra en dos clics sigue bloqueada** por un `internal_error` de
Mercado Pago que no depende de nosotros. Guardar la tarjeta funciona,
tokenizarla también, y cobrar con ella devuelve 500 sin causa. Habría que
consultarle a soporte con los datos que dejé en RESULTS.

**3. Decidí si seguimos con el orden previsto.** Lo siguiente sería
**Sellers → Stores → Products**, que es lo que le da contenido real al feed.

---

## Bugs reales que aparecieron y se arreglaron

Ninguno lo hubiera encontrado un test.

| Qué | Consecuencia si llegaba a producción |
|---|---|
| `Boolean("false")` es `true` en JavaScript | El interruptor que apagaba los módulos de spike **no apagaba nada** |
| Clave de idempotencia por orden | **Una orden rechazada no se podía pagar nunca más** |
| Orden trabada sin pago | La orden quedaba inutilizable y nadie podía reintentar |
| `this` no era el CardForm | El formulario de pago se colgaba en silencio |
| Errores de Mercado Pago sin traducir | El comprador leía `invalid card_number_validation` |

Y uno del que quiero dejar constancia: **se borraron archivos del proyecto**
—el `.git`, el `README` y toda la configuración del backend— y los recuperé.
No sé qué lo causó y no puedo descartar que haya sido algo mío. El código
fuente no se tocó. Está todo detallado en el historial de git.

Por eso el repositorio en GitHub dejó de ser opcional.
