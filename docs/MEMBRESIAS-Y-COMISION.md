# Membresías y comisión — especificación

**Estado: aprobado comercialmente, sin construir.** Se construye después de que
Railway esté verde.

Este documento existe para que la decisión no viva en un chat. Cada bloque dice
qué hay hoy en el código, qué falta, y qué riesgo tiene.

---

## 0. Lo que ya está construido

Vale la pena empezar por acá, porque cambia mucho el tamaño de lo que sigue.

| Pieza | Dónde | Estado |
|---|---|---|
| Planes `FREE` / `PRO` | `MembershipPlan` en el esquema | ✅ |
| Beneficios por plan | `BENEFICIOS_POR_PLAN` en `sellers/membresias.ts` | ✅ desacoplado |
| Límites por plan | `LIMITES_POR_PLAN` (cupones, días de historial) | ✅ |
| Origen del plan | `MembershipOrigin` con `PAGO` ya reservado | ✅ |
| Comisión configurable | `VENDOX_PLATFORM_FEE_BPS`, un solo lugar de cálculo | ✅ |
| Comisión congelada por orden | `Order.platformFeeBps` | ✅ **clave** |
| Ejemplo de precio al vendedor | `politicas_screen.dart`, con tasas del servidor | ✅ parcial |

**`Order.platformFeeBps` es lo que hace todo esto seguro.** Cada orden guarda la
tasa con la que se cobró. Cambiar la comisión —o hacerla variable por volumen—
no reescribe nunca lo ya vendido, y una auditoría de una venta vieja da el
número que se cobró ese día, no el de hoy.

---

## 1. Comisión base: 6 % → 4 %

**Tamaño: una línea y actualizar tests.**

```
VENDOX_PLATFORM_FEE_BPS: default 600 → 400
```

Sigue calculándose donde ya se calcula, sobre el producto y sobre el precio
**efectivamente pagado** tras descuento — nunca sobre envío, costo de
procesador ni precio de lista. Eso no cambia.

**Tests a tocar:** `orders-pricing.spec.ts` asierta `6_000` sobre `99_999`, y
hay una aserción de neto con `− 6_000`. Ambas pasan a los valores del 4 %.
También `invariantes.spec.ts` si toca el número.

**Riesgo: bajo.** Órdenes existentes intactas por el snapshot.

---

## 2. Plan Business

**Tamaño: mediano.** Migración + decidir beneficios.

```
enum MembershipPlan { FREE, PRO, BUSINESS }
```

| | Free | Pro — $4.500/mes | Business — $15.000/mes |
|---|---|---|---|
| Mensaje | Empezá a vender | **Vendé más** | **Gestioná tu negocio a escala** |
| Productos publicados | **3** | ampliado / ilimitado | ilimitado |
| LIVE | básico | herramientas avanzadas | ídem + masivas |
| Chat, pedidos, cobros | ✅ | ✅ | ✅ |
| Cupones | ✗ | ✅ | ✅ |
| Ofertas LIVE | ✗ | ✅ | ✅ |
| Programación de vivos | ✗ | ✅ | ✅ |
| Estadísticas | básicas | avanzadas | más profundas |
| Promociones / créditos | ✗ | ✅ | más créditos |
| Personalización de tienda | básica | mayor | ídem |
| Reportes | ✗ | ✅ | avanzados + exportaciones |
| Multiusuario, roles y permisos | ✗ | ✗ | ✅ |
| Automatizaciones, logística avanzada | ✗ | ✗ | ✅ |
| Prioridad de soporte | ✗ | ✗ | ✅ |

**Regla que ya está escrita en el código y hay que respetar:**

> Cada entrada de la lista de beneficios tiene que corresponder a algo que
> **existe**. Una lista de promesas es una lista de reclamos: si dice
> `ANALITICA_AVANZADA` y la pantalla no está, alguien pagó por nada.

Así que Business se lanza con los beneficios **construidos**, no con la tabla
completa. Multiusuario y roles son features grandes por sí solas.

**Qué hace falta:**

1. Migración de Prisma para el valor nuevo del enum
2. Entrada en `BENEFICIOS_POR_PLAN` y `LIMITES_POR_PLAN`
3. Beneficios nuevos: `OFERTAS_LIVE`, `PROGRAMAR_VIVOS`, `EXPORTACIONES`,
   `MULTIUSUARIO`, `SOPORTE_PRIORITARIO`
4. Pantalla de planes en la app: hoy muestra dos

---

## 3. Tope de 3 productos en Free

**Tamaño: mediano.** Hoy **no existe ningún tope**: se puede publicar sin límite
en cualquier plan.

**Dónde va:** en `products.service.ts`, al pasar a `ACTIVE` — no al crear. Un
borrador no ocupa cupo; lo que se limita es la vidriera.

**Decisiones que faltan y son tuyas:**

- Un vendedor Free con 10 productos publicados **hoy**, ¿qué pasa cuando se
  aplique el tope? Lo correcto es no despublicar nada: se le impide publicar el
  siguiente y se le explica. Despublicarle seis productos sin avisar sería
  sacarle ventas ya hechas.
- ¿El tope cuenta productos o variantes? Propuesta: productos.
- Al bajar de Pro a Free con 20 publicados, mismo criterio: no se toca lo
  publicado, no puede publicar más.

**Riesgo: medio.** Un gate mal puesto bloquea a vendedores que ya estaban
vendiendo. Necesita test del caso «ya tenía más del tope».

---

## 4. Comisión por volumen

**Tamaño: grande. Es el único bloque que toca la matemática del dinero.**

| Venta semanal | Comisión |
|---|---|
| Menos de $3.000.000 | 4 % |
| Desde $3.000.000 | 3,5 % |
| Desde $5.000.000 | 3 % |

Sobre el ejemplo: un vendedor de $5.000.000 semanales pasa de $200.000 a
$150.000 de comisión. **$50.000 por semana**, $2,6 M al año. El número es
suficientemente grande como para que el cálculo tenga que ser auditable.

### La ventana

Vos ya identificaste el problema: una semana aislada se manipula —basta
concentrar ventas— y además castiga la estacionalidad. Un vendedor que factura
fuerte en Navidad y flojo en febrero saltaría de nivel cada quince días.

**Propuesta: promedio móvil de las últimas 4 semanas, evaluado al crear la
orden.** Concreto:

- Se suma el GMV de producto —sin envío— de las órdenes en estado vendido de
  los últimos 28 días
- Se divide por 4 → venta semanal promedio
- Ese promedio elige el tramo
- El `platformFeeBps` resultante se **congela en la orden**, como ya pasa hoy

### Lo que hay que resolver antes de construir

1. **Qué órdenes cuentan.** Ya existen tres listas distintas de «qué cuenta como
   venta» en el código, con dos definiciones diferentes — está anotado en la
   auditoría nocturna. Para esto hay que unificar una sola, y las devueltas no
   pueden contar.
2. **Devoluciones.** Si una venta se devuelve, ¿baja el volumen y sube la
   comisión retroactivamente? **No.** Lo cobrado queda cobrado. Pero el GMV del
   período siguiente sí debería excluirla.
3. **Rendimiento.** Sumar 28 días de órdenes en cada checkout es un viaje a la
   base en el camino más caliente. Conviene un contador materializado por
   vendedor, actualizado al confirmar una venta.
4. **Visibilidad.** El vendedor tiene que poder ver en qué tramo está y cuánto
   le falta para el siguiente. Un descuento que nadie ve no motiva nada.
5. **¿Business únicamente, o todos?** El texto comercial dice «la comisión puede
   bajar según volumen» bajo Business. Si aplica a todos los planes, Business
   pierde ese argumento de venta.

**Riesgo: alto.** Es el corazón del dinero. Se hace solo, con la plataforma
andando, y con sabotaje sobre cada tramo.

---

## 5. Transparencia al publicar

**Tamaño: chico. El 80 % ya existe.**

`politicas_screen.dart` ya muestra el desglose con comisión y costo estimado de
Mercado Pago, y desde el 17/08 las **tasas vienen del servidor** en vez de estar
escritas a mano — así que no puede desincronizarse.

**Lo que falta:**

### 5.1 Llevar el desglose al editor de producto

Al escribir el precio, debajo:

```
Precio que ve quien compra      $100.000
Comisión de VendoX (4 %)         −$4.000
Costo de Mercado Pago (aprox.)   −$6.190
─────────────────────────────────────────
Estimado que recibís             $89.810
```

Con la aclaración que ya está redactada en Políticas: *el costo real lo informa
Mercado Pago después de cobrar y depende del medio de pago y del plazo*.

⚠️ **La palabra «estimado» no es decorativa.** El costo del procesador sólo se
sabe después. Presentar el neto como exacto sería la misma clase de promesa
incumplible que el aviso de perfil.

### 5.2 «¿Cuánto querés recibir?»

La inversa. El vendedor pone `$100.000` y VendoX sugiere `$113.500` aprox.

Es despejar la misma fórmula. Requiere cuidado con el redondeo: la ida y la
vuelta tienen que cerrar, o el vendedor ve `$100.000 → $113.500 → $99.998` y
pierde la confianza que esta función viene a construir. **Test de ida y vuelta
obligatorio.**

**Riesgo: bajo.** No toca el cobro: es cálculo de presentación. El precio que se
cobra lo sigue decidiendo el backend.

---

## 6. Ofertas LIVE

**Tamaño: muy grande. Cero base en el código.**

### El diseño legal es correcto

**No es una subasta y no hay adjudicación automática.** El vendedor recibe
ofertas y decide una por una. Esa diferencia es la que evita el encuadre
regulatorio de remate, y tiene que estar visible en la pantalla, no sólo en los
términos:

> Las ofertas no constituyen una subasta ni una adjudicación automática. El
> vendedor decide aceptar o rechazar cada oferta.

### Qué configura el vendedor

- Aceptar ofertas: sí / no
- Oferta mínima
- Duración: 5, 10, 20 o 30 minutos
- Incremento mínimo (opcional)
- Cerrar antes, o aceptar en cualquier momento

### Qué hace falta construir

| Pieza | Nota |
|---|---|
| Modelo `LiveOffer` | producto, vivo, comprador, monto, estado, timestamps |
| Estados | `ABIERTA` → `ACEPTADA` / `RECHAZADA` / `VENCIDA` / `RETIRADA` |
| Emisión en tiempo real | ya existe el gateway de Socket.IO del vivo |
| Cierre por tiempo | mismo patrón que el vencimiento de reservas |
| Aceptar → orden | reusar el checkout actual, sin camino nuevo de dinero |
| Pantalla del comprador | oferta actual, cuánto queda, botón ofertar |
| Panel del vendedor | lista de ofertas, aceptar/rechazar |

### Lo que hay que resolver antes

1. **Aceptar una oferta ¿reserva stock?** Si no, dos aceptaciones sobre la misma
   unidad venden lo que no hay. Debería tomar el mismo camino de reserva que
   una compra normal.
2. **¿Qué pasa si el elegido no paga?** Propuesta: la orden vence como
   cualquier otra y el vendedor puede aceptar otra oferta.
3. **Ofertas de alguien bloqueado** — el filtro de bloqueos ya existe.
4. **Retención**: las ofertas de un vivo terminado, ¿cuánto se guardan? El chat
   se poda a 30 días; conviene el mismo criterio.
5. **Veracidad**: la oferta más alta que se muestra tiene que ser real. Es la
   regla que ya rige todo lo demás — nunca inventar actividad.

**Riesgo: alto.** Realtime, dinero, stock y encuadre legal en la misma feature.
Se hace sola.

---

## Orden sugerido

1. **Railway verde** ← acá estamos
2. Comisión al 4 % *(una línea)*
3. Transparencia al publicar + «cuánto querés recibir» *(chico, mucho valor)*
4. Plan Business con los beneficios que **existan** *(mediano)*
5. Tope de 3 productos en Free *(mediano, decisión sobre los que ya publicaron)*
6. Comisión por volumen *(grande, solo, con la plataforma andando)*
7. Ofertas LIVE *(muy grande, bloque propio)*

Los pasos 2 y 3 juntos ya dan el argumento comercial completo:

> Antes de publicar, VendoX te muestra cuánto vas a pagar y cuánto estimamos
> que vas a recibir. Sin costos escondidos.

---

## Depende de terceros

| Bloque | Depende de |
|---|---|
| Cobro de Pro y Business | **Google Play Billing** — producto de suscripción, cuenta de servicio, RTDN |
| Todo lo demás | nada externo |

La arquitectura de membresías **ya está desacoplada del proveedor de cobro**:
`MembershipOrigin.PAGO` existe, los beneficios dependen del plan y no del
proveedor, y no hay una sola referencia a Play en el modelo. Play Billing entra
como un módulo que verifica la compra y llama a `otorgar(..., 'PAGO')`.
