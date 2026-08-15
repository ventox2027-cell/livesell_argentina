# Política de contenido generado por usuarios

Qué modera VendoX, qué es automático, qué lo decide una persona, y qué NO
hacemos.

Este documento describe **lo que el código hace hoy**. Si algo de acá no está
implementado, es un error del documento, no una promesa.

---

## El principio

> **Un reporte no sanciona a nadie.**

Un reporte arma una cola para que una persona mire. La única acción automática
es **ocultar preventivamente un producto** cuando varias personas distintas lo
reportan por el mismo motivo — y ocultar es reversible, con aviso al vendedor.

Nadie queda suspendido por un umbral. Suspender tiene consecuencias económicas
para alguien y esas decisiones las toma una persona.

---

## Qué es automático

Sólo tres cosas, y ninguna sanciona a una cuenta.

### 1 · Filtro del chat del vivo

Una **lista de palabras**. No es un clasificador y no pretende serlo: cuando
alguien reclama "¿por qué no me dejó escribir esto?", la respuesta tiene que ser
una línea que se puede leer.

Frena tres cosas:

| Qué | Por qué |
|---|---|
| Teléfonos, correos, usuarios de redes | Sacar la operación afuera deja a quien compra sin comprobante y sin forma de reclamar. Es la forma más común de estafa. |
| Enlaces | Lo mismo, más phishing. |
| Ataques dirigidos y discriminación | Lista corta, configurable con `CHAT_PALABRAS_PROHIBIDAS`. |

**Putear no está prohibido.** Un "qué caro la puta madre" es alguien mirando un
precio. La lista tiene ataques dirigidos, no palabrotas, y hay un test que lo
fija.

**El filtro frena el mensaje y lo registra. No sanciona.** Un filtro que
sanciona convierte cada falso positivo en un castigo, y los falsos positivos son
inevitables.

Los mensajes frenados **se guardan igual**: sin ellos no hay forma de saber si el
filtro se está pasando de estricto y silenciando gente que no hizo nada.

### 2 · Ocultamiento preventivo de productos

Cuando varias personas **distintas** reportan el mismo producto por el **mismo
motivo**:

| Motivo | Reportes |
|---|---|
| Producto prohibido | 1 |
| Contenido sexual | 1 |
| Violencia o discriminación | 2 |
| Falsificado · Contenido robado · Parece una estafa | 3 |
| No coincide con lo publicado · Spam | 5 |

Por qué es por motivo y no sobre el total: cinco reportes repartidos entre cinco
motivos distintos son ruido; cinco por el mismo motivo son una señal.

Los umbrales de 1 son los casos donde el daño de dejarlo cinco minutos más es
mayor que el de ocultarlo mal.

**Sólo aplica a productos.** Un vivo dura minutos —para cuando el umbral se
cumple, ya terminó— y una cuenta no se sanciona nunca por umbral.

### 3 · Límites de abuso

Antiflood en el chat (5 mensajes cada 10 segundos), largo máximo de 200
caracteres, y límites por hora en reportes (20), bloqueos (60) y silencios
(100). No son moderación: son control de abuso.

---

## Qué decide una persona

Todo lo demás.

| Acción | Quién |
|---|---|
| Confirmar o desestimar un reporte | Moderación (`/moderacion` en el admin) |
| Ocultar o restaurar contenido | Moderación |
| Suspender un vendedor o una cuenta | Moderación |
| Silenciar sin fecha de vencimiento | Moderación |
| Silenciar en todos los vivos | Moderación |
| Borrar un mensaje de SU vivo | El vendedor |
| Silenciar en SU vivo, hasta 24 h | El vendedor |

**El vendedor manda en su sala, no en la plataforma.** Callar a alguien durante
un vivo es moderar su propio espacio; callarlo para siempre o en todos lados es
una sanción.

**Toda acción de moderación exige motivo** —mínimo diez caracteres— y queda en
`ModerationAction` con quién, cuándo y por qué. Sin actor registrado significa
que la tomó el sistema por umbral, y esa distinción importa: una acción
automática y una decidida por una persona no se defienden igual.

---

## Qué puede hacer cada persona por su cuenta

### Bloquear

Decisión personal: inmediata, reversible, **sin consecuencias para la otra
persona** y sin revisión.

- Quien es bloqueado **no se entera**. Avisarle es darle un motivo y un
  objetivo.
- El ocultamiento del feed es **unilateral**: si B bloquea a A, A sigue viendo
  los vivos de B. Lo contrario permitiría hacerle desaparecer la tienda a un
  competidor.
- El **chat sí es simétrico**: de nada sirve no leer a quien molesta si esa
  persona puede seguir escribiendo.
- **No cancela pedidos en curso.** Una compra hecha es un contrato y no se
  deshace porque una parte deje de querer ver a la otra.

### Reportar

Pedirle a VendoX que revise algo. Se puede reportar:

| Destino | Desde dónde |
|---|---|
| Un vivo | Columna de acciones del vivo |
| Una tienda | Menú del perfil del vendedor |
| Un producto | Toque largo en la tienda del vivo |
| Un mensaje de chat | Toque largo en el mensaje |
| Una persona | Toque largo en un mensaje → "Reportar a …" |

**A quien reporta se le contesta siempre lo mismo**, haya disparado un umbral o
no. Decirle "con el tuyo lo bajamos" convertiría el umbral en un juego.

**Una persona reporta una cosa una vez.** Un índice único convierte una campaña
de veinte reportes de la misma persona en un solo reporte.

---

## Lo que NO hacemos

- **No usamos IA para sancionar.** Puede clasificar o priorizar; las sanciones
  salen de reglas explícitas o de revisión humana.
- **No hay moderación automática "inteligente".** No existe y el documento no
  la promete.
- **No ocultamos por un solo reporte** salvo en las dos categorías críticas de
  arriba, que están explícitas y son reversibles.
- **No le decimos a nadie quién lo reportó.** Un vendedor que lo sabe puede
  represaliar, y entonces nadie reporta dos veces.
- **No guardamos el chat para siempre.** 30 días, que es lo que tarda un reporte
  en abrirse, revisarse y resolverse. Después se borra.

---

## Retención

| Dato | Cuánto | Por qué |
|---|---|---|
| Mensajes del chat | 30 días | Lo que dura un ciclo de reporte. Después es una base de conversaciones privadas creciendo sin límite. |
| Reportes | Sin límite definido | Es el registro de una decisión de moderación. |
| Acciones de moderación | Sin límite definido | Es lo que se mira ante un reclamo, meses después. |
| Bloqueos | Mientras existan | Los borra quien los puso, o el cierre de cualquiera de las dos cuentas. |

---

## Lo que falta

Honestidad sobre el estado, para que nadie lea este documento como una promesa
de algo que no existe:

- **No hay reporte de reseñas desde la app.** El backend lo soporta
  (`targetType: 'REVIEW'`), pero ninguna pantalla lista reseñas todavía.
- **No hay expulsión de un vivo.** Hay silencio temporal, que es lo que resuelve
  el caso real. Echar a alguien de una sala pública requiere decidir qué pasa si
  vuelve a entrar, y esa decisión no está tomada.
- **No hay notificación al reportante** cuando su reporte se resuelve. Es
  deliberado por ahora: contarle el desenlace es contarle qué pasó con la cuenta
  de otra persona.
