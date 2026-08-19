# Comisión por volumen y planes — cómo funciona

**Estado: construido y en verde.** Este documento describe lo que hay en el
código, no lo que se planea.

La especificación comercial previa está en
[MEMBRESIAS-Y-COMISION.md](MEMBRESIAS-Y-COMISION.md). Cuando difieran, manda
éste: aquél es de antes de construirlo.

---

## Los tres planes

| | Free | Pro | Business |
|---|---|---|---|
| Productos publicados a la vez | **3** | sin tope | sin tope |
| Cupones activos | 0 | 20 | 50 |
| Días de historial en métricas | 30 | 365 | 730 |
| Analítica avanzada (embudo del vivo) | — | ✅ | ✅ |
| Insignia Pro | — | ✅ | ✅ |
| Soporte prioritario | — | — | ✅ |
| Comisión reducida por volumen | — | — | ✅ |

Todo lo de esa tabla existe en el código y tiene tests. Lo que **no** está, y
por qué:

- **Exportaciones y reportes.** El único export que existe es el de la Ley
  25.326 —acceso a los propios datos—, que es un derecho legal, gratuito y de
  toda persona. No se puede vender. Si se quiere un producto de reportes
  (ventas por período, ranking de productos, CSV), hay que construirlo: es un
  bloque propio.
- **Más créditos de promoción.** El libro mayor de créditos existe, pero hoy
  sólo los otorga un admin a mano. No hay otorgamiento recurrente por plan.
- **Multiusuario, roles, sucursales, automatizaciones.** No existen.

> Cada entrada de `BENEFICIOS_POR_PLAN` tiene que corresponder a algo que
> funciona. Una lista de promesas es una lista de reclamos.

### El soporte prioritario es real

No es una línea en una pantalla de precios: `support.service.ts::bandeja()`
busca los tickets de Business vigente sobre la tabla entera y los pone arriba
de la cola del equipo. Entre dos Business sigue mandando quién esperó más — la
prioridad adelanta en la cola, no habilita a colarse entre iguales.

Un Business **vencido** no tiene prioridad, y hay un test que lo prueba.

---

## El límite de catálogo de Free

Hasta **3 productos publicados a la vez**. Publicados, no cargados.

- Los borradores no cuentan. Se pueden cargar cuarenta.
- Los pausados no cuentan. Pausar uno libera lugar.
- Los archivados y borrados no cuentan.

Quien ya tenía más de tres cuando se introdujo el límite **los conserva**. El
tope frena publicar uno más; no despublica nada ni pide elegir cuáles se queda.

Se valida en el servidor, en los dos caminos que publican: crear con
`status: ACTIVE` y editar un borrador a `ACTIVE`. Este segundo es el flujo
normal de la app —se arma la ficha, se suben fotos, se publica al final— así
que sin él el tope se salteaba en dos pasos sin proponérselo.

Va dentro de la transacción con un cerrojo por vendedor
(`pg_advisory_xact_lock`): «contar y después escribir» es una carrera, y dos
toques rápidos dejarían cuatro publicados.

`GET /products/mine` devuelve `catalogo: { publicados, limite, puedePublicar }`
para que la app muestre «2 de 3 productos publicados» y apague el botón antes
de que alguien choque el límite.

---

## La comisión

La base es **4 %** (`VENDOX_PLATFORM_FEE_BPS`), sobre el **producto** y sobre
el **precio efectivamente pagado**:

```
base = max(0, itemsSubtotal − discountAmount)
```

No sobre el envío, no sobre el recargo del procesador, no sobre el precio de
lista.

### Los tramos de Business

| Promedio semanal | Comisión |
|---|---|
| menos de $3.000.000 | 4 % |
| desde $3.000.000 | 3,5 % |
| desde $5.000.000 | 3 % |

**Sólo Business.** Free y Pro pagan siempre la base: bajar la comisión por
volumen es el argumento comercial de Business, y si aplicara a todos los planes
Business perdería su razón de existir.

Un tramo **nunca sube** la comisión. Si la base quedara por debajo de un tramo,
gana la base.

### La ventana móvil: 28 días, promediados en 4

Una semana aislada se manipula —basta concentrar ventas en siete días— y
castiga la estacionalidad: quien factura fuerte en diciembre y flojo en febrero
saltaría de nivel cada quince días.

Veintiocho días partidos en cuatro suavizan las dos cosas sin volverse lentos:
un vendedor que crece de verdad llega al tramo siguiente en un mes.

Se corta por `createdAt`, no por `confirmedAt`: si no, la misma orden entraría
y saldría de la ventana según cuánto tardó el vendedor en preparar el pedido.

### Qué cuenta como volumen

La base de medición son las órdenes con `confirmed_at` distinto de null. O sea:
las que **llegaron a ser una venta**, incluidas las que después se devolvieron.

```
brutoConfirmado  = Σ max(0, itemsSubtotal − discountAmount)
devuelto         = Σ min(base, montoDevuelto × base / bruto)
volumenElegible  = brutoConfirmado − devuelto
promedioSemanal  = volumenElegible / 4
```

Una orden completamente devuelta entra en `brutoConfirmado` y sale entera por
`devuelto`: neto cero. Lo que se gana con contarla en las dos columnas es poder
medir la tasa de devolución — con la lista de estados, un vendedor que devuelve
todo tendría cero ventas en pie, la tasa daría `0/0 = 0 %` y el que más devuelve
mediría mejor que nadie.

Sólo cuentan las devoluciones **`COMPLETED`**. Una `PENDING` que después falla
habría sacado un tramo cuya comisión ya quedó congelada.

> ⚠️ **Hoy toda devolución es total.** `payments.service.ts` la crea con el
> cobro completo, y la máquina de estados ni siquiera deja devolver una orden
> ya despachada. El prorrateo está escrito y probado igual, para que el cálculo
> esté bien antes de que exista el flujo parcial.

### La salvaguarda por devoluciones

Un Business cuya **tasa de devolución supere el 10 %** no accede a ningún
tramo: paga la base hasta que vuelva por debajo.

```
tasaDeDevolucion = devuelto / brutoConfirmado
```

Sin esto el descuento se puede fabricar: alcanza con inflar la ventana con
órdenes que después se devuelven, para conseguir una tasa más barata congelada
en las órdenes reales de esa misma ventana. La orden inflada vuelve; el
descuento que consiguió, no.

El umbral vive en **`VENDOX_BUSINESS_MAX_REFUND_BPS`** (por omisión `1000`) y en
ningún otro lado. Es un número de política comercial, no una constante de
dominio: si el rubro resulta tener devoluciones altas de forma legítima
—indumentaria por talle— ajustarlo tiene que ser una variable de entorno.

La comparación es con enteros y sin dividir:

```
devuelto × 10000 > brutoConfirmado × umbral
```

No redondea, así que ningún centavo cae del lado equivocado por un artefacto de
coma flotante. Y es **estrictamente mayor**: justo en el 10 % el vendedor
conserva el descuento, porque el borde exacto no supera nada.

No es una sanción permanente ni requiere que nadie intervenga. La ventana es
móvil: en cuanto las devoluciones salen de los 28 días, el tramo vuelve solo.

---

## La comisión se congela por orden

Cada orden guarda con qué se le cobró y **por qué**:

| Columna | Qué guarda |
|---|---|
| `platform_fee_bps` | el porcentaje aplicado |
| `platform_fee_amount` | el importe |
| `platform_fee_reason` | `PLAN_SIN_TRAMOS`, `VOLUMEN_INSUFICIENTE`, `VOLUMEN_BUSINESS`, `DEVOLUCIONES_ALTAS` |
| `platform_fee_weekly_volume` | el promedio semanal con el que se decidió |
| `platform_fee_refund_rate_bps` | la tasa de devolución medida |
| `platform_fee_evaluated_at` | el final de la ventana que se usó |

Las tres últimas son las **entradas** de la decisión, no su resultado. Van
congeladas porque la ventana es móvil: recalcular mañana da otro número, así que
sin guardarlas no hay forma de reconstruir por qué esta orden cayó en el tramo
que cayó.

**Ninguna orden se recalcula nunca.** Si un vendedor pierde Business mañana, sus
órdenes de hoy siguen diciendo 3,5 %.

Las órdenes anteriores a este bloque tienen las cuatro columnas en `NULL` y así
se quedan: ponerles `BASE` sería casi cierto, pero afirmaría que alguien evaluó
tramos cuando no existían.

### Si falla la consulta

`TasaDeComision` **nunca lanza**. Corre en el camino de crear una orden y un
fallo no puede impedir una compra: cae a la tasa base, registra el error, y la
venta sigue.

La caída es a la base —a favor de VendoX— porque es la única dirección
defendible. Un vendedor que quedó sin su tramo por un error puntual tiene un
reclamo con respuesta, porque el motivo quedó en la orden; un descuento
regalado por un timeout no se puede deshacer.

---

## Lo que ve el vendedor

`GET /stores/me` devuelve:

```json
{
  "comisionBps": 350,
  "costoDelProcesadorBps": 619,
  "comision": {
    "bps": 350,
    "etiqueta": "Comisión VendoX Business (3,5%)",
    "bajoPorVolumen": true,
    "aviso": "Tu comisión bajó por volumen de ventas."
  }
}
```

La etiqueta viene armada del servidor. La app podría componerla, pero eso sería
un `switch` sobre motivos de tasa dentro de Flutter: dos copias de la misma
regla, y la del teléfono desactualizada hasta la próxima versión publicada.

**No hay ningún porcentaje escrito en Dart.** Ya pasó dos veces —la pantalla de
políticas con `600` y la de Pro con «6 %» en el texto— y las dos veces siguió
funcionando todo mientras le mostraba al vendedor un número que no era el suyo.

El `aviso` es `null` en el caso normal. Aparece en dos situaciones, y las dos
son novedades reales: cuando la comisión bajó por volumen, y cuando el vendedor
tiene el volumen pero las devoluciones lo dejaron afuera. Lo segundo se le dice
explícitamente: callarlo sería lo peor de los dos mundos —paga más y no sabe
que hay algo que puede corregir.

### La comisión no sale en la vidriera pública

`GET /stores/by-slug/:slug` **no** incluye `comisionBps`. Antes sí: con una
comisión única era información sin dueño, pero con tramos por volumen pasa a
decir qué plan tiene cada vendedor y cuánto factura por semana. Un comprador que
lee «3 %» puede deducir que esa tienda vende más de cinco millones semanales.

---

## Configuración

| Variable | Por omisión | Qué es |
|---|---|---|
| `VENDOX_PLATFORM_FEE_BPS` | `400` | la comisión base, en puntos básicos |
| `VENDOX_BUSINESS_MAX_REFUND_BPS` | `1000` | techo de devoluciones para acceder a los tramos |
| `PROCESSOR_FEE_ESTIMATE_BPS` | `619` | estimación del costo de Mercado Pago |

Los tramos de volumen **no** son configurables: viven en `TRAMOS_BUSINESS`, en
`comision-por-volumen.ts`. Cambiarlos es una decisión comercial que merece un
diff y un test, no una variable de entorno que alguien toca de madrugada.

---

## Lo que falta

**Google Play Billing.** No hay cobro: los planes se otorgan desde el panel de
administración con `otorgar(sellerId, { plan, periodo, origen })`, y queda
auditado con el motivo. `MembershipOrigin.PAGO` está reservado para cuando
exista. Ningún archivo de membresías nombra un proveedor de pago, y esa
separación es la que hace que agregar el cobro sea agregar un llamador.

**Devoluciones parciales.** El cálculo ya las contempla; el flujo que las cree
no existe.

**Renovar de Pro a Business.** `calcularVencimiento` suma al final en vez de
reemplazar, así que un Pro con veinte días por delante que pasa a Business
obtiene Business por esos veinte días sin costo adicional. Con otorgamiento
manual y auditado no es un problema; con cobro automático hay que decidir si se
prorratea.

---

## Dónde está cada cosa

| | Archivo |
|---|---|
| Qué cuenta como venta, la medición y la ventana | `sellers/volumen.ts` |
| Los tramos y la salvaguarda (puro) | `sellers/comision-por-volumen.ts` |
| Juntar los datos y resolver la tasa | `sellers/tasa-de-comision.service.ts` |
| Planes, beneficios y límites | `sellers/membresias.ts` |
| El tope de catálogo | `sellers/limite-de-catalogo.ts` |
| La base de comisión y la aritmética | `orders/pricing.ts` |

Tests: `test/unit/volumen.spec.ts`,
`test/unit/comision-por-volumen.spec.ts`, `test/unit/membresias.spec.ts`,
`test/integration/volumen-flow.spec.ts`, y los bloques de comisión en
`orders-flow.spec.ts` y `commerce-flow.spec.ts`.
