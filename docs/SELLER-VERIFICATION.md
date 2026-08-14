# Verificación de vendedores y riesgo

Reducir vendedores falsos, identidades robadas y fraude antes de abrir LIVE al
público.

---

## Las dos preguntas que NO son la misma

```
¿Sabemos quién es?          →  verificación de identidad
¿Es un buen vendedor?       →  reputación y riesgo
```

Mezclarlas es el error clásico. Alguien con DNI verificado puede estafar; y
alguien sin verificar puede llevar dos años vendiendo bien.

Por eso son dos conceptos separados, con **dos insignias distintas** de cara al
comprador:

| | Qué es | De dónde sale |
|---|---|---|
| **Identidad verificada** | un hecho comprobable | `SellerVerification.state = VERIFIED` |
| **Vendedor confiable** | un historial | nivel de riesgo + ventas completadas |

No deben mostrarse como lo mismo.

---

## El documento no se guarda

**Nunca.** Llega en la petición, se usa para consultar al proveedor, y se
descarta. Lo que queda en la base es:

- un **HMAC** del número
- los **últimos cuatro dígitos**

### Por qué alcanza

El hash permite detectar **el mismo documento en dos cuentas de vendedor**, que
es la señal de fraude más directa que existe: identidad robada, o alguien
evadiendo una suspensión con una cuenta nueva. Y lo hace sin que el número esté
en ningún lado.

Los últimos cuatro alcanzan para que soporte confirme por teléfono que hablan
del mismo documento.

### Por qué HMAC y no un hash pelado

Un SHA-256 de un DNI argentino se revierte por fuerza bruta en segundos: son
cien millones de combinaciones y una tabla precalculada entra en un pendrive.
Con una clave secreta de por medio, esa tabla no se puede construir sin robarla
primero.

> ⚠️ **Rotar `JWT_SECRET` invalida las huellas.** Los duplicados dejarían de
> detectarse hasta que cada vendedor reenvíe sus datos. Lo correcto sería una
> clave propia y rotable por separado; reutilizar una que ya existe y ya está
> protegida es mejor que inventar una tercera variable que alguien va a dejar
> vacía en staging. Anotado como deuda.

### El test que lo sostiene

`seller-verification.spec.ts` busca el número crudo con SQL directo en
`seller_verifications` y en `audit_logs`, y falla si aparece. No comprueba el
código: comprueba el resultado.

---

## Estados

```
NOT_STARTED → PENDING → IN_REVIEW → VERIFIED
                            ↓
                        REJECTED → (puede reenviar)
```

- **Reenviar tras un rechazo se permite.** La gente se equivoca tipeando, y no
  poder corregirlo dejaría cuentas legítimas trabadas para siempre.
- **Reenviar durante la revisión no.** Cambiaría los datos bajo los pies de
  quien está mirando.
- **Dos admins no pueden tomar la misma verificación.** La condición va en el
  `WHERE` del `UPDATE`: si otro llegó primero, afecta cero filas y lo sabemos
  sin una lectura previa que se pueda desactualizar.

---

## Proveedores de identidad

**No hay integración con RENAPER ni con ARCA.** No tenemos contrato ni
credenciales.

Lo que hay es la interfaz y un **proveedor manual que dice la verdad**: la
revisión la hace una persona, y el resultado se guarda como
`provider = "manual"`.

> No existe un `RenaperProvider` que devuelva `true` sin llamar a nadie. Sería
> una mentira que en tres meses alguien va a creer, y tendríamos vendedores
> "verificados por RENAPER" que nunca pasaron por ahí.

Lo que el proveedor manual sí comprueba es la **forma**: un DNI de 7 u 8
dígitos, y el **dígito verificador del CUIT** (módulo 11). Es aritmética local
que descarta el error más común —un dígito mal tipeado— sin hacer esperar una
revisión manual para decir eso.

Cuando exista el contrato: se escribe un adaptador, se cambian dos líneas en
`sellers.module.ts`, y nada del dominio se entera.

---

## Riesgo: reglas y motivos, sin puntaje

Sería fácil sumar señales ponderadas y devolver un 73. Y sería peor.

Un número opaco no se puede discutir. Cuando un vendedor pregunte por qué lo
limitaron, "el sistema le asignó 73" no es una respuesta: no dice qué hizo mal
ni qué puede corregir.

Cada regla que dispara **agrega su motivo a una lista**. El nivel final es la
severidad más alta.

### Las reglas

| Código | Nivel | Cuándo |
|---|---|---|
| `documento_duplicado` | ALTO | el mismo DNI en otra cuenta de vendedor |
| `suspendido_antes` | ALTO | fue suspendido alguna vez |
| `devoluciones_muchas` | ALTO | 6 o más en 30 días |
| `cambio_critico_reciente` | ALTO | cambió cuenta de cobro o teléfono en 7 días |
| `identidad_sin_verificar` | MEDIO | — |
| `sin_cuenta_de_cobro` | MEDIO | — |
| `telefono_sin_verificar` | MEDIO | — |
| `cuenta_nueva` | MEDIO | menos de 14 días |
| `devoluciones_algunas` | MEDIO | 3 a 5 en 30 días |
| `cancelaciones` | MEDIO | 5 o más en 30 días |
| `crecimiento_anormal` | MEDIO | ventas ×10 respecto de la semana previa |

### La severidad no se promedia

Cinco señales intermedias no son peores que un documento duplicado. Un vendedor
con 120 ventas limpias cuyo DNI aparece en otra cuenta es **riesgo alto**: si el
nivel fuera un promedio ponderado, esas 120 ventas diluirían la única señal que
importa.

### La trayectoria supera algunas señales, no todas

Un vendedor verificado, cobrando y con 10+ ventas baja a riesgo bajo aunque
tenga señales intermedias sueltas. Sin esa salida, "cuenta nueva" mantendría a
todo el mundo en medio para siempre.

**Pero sólo supera señales de estado**, no de comportamiento:

| Tipo | Ejemplos | ¿La trayectoria las supera? |
|---|---|---|
| De estado | teléfono sin verificar, cuenta nueva | **sí** — el historial las responde |
| De comportamiento | crecimiento ×10, cancelaciones, devoluciones | **no** — están pasando ahora |

Una cuenta consolidada es justamente la más útil para probar tarjetas robadas,
porque no levanta ninguna de las otras sospechas. *(Esta distinción faltaba en
la primera versión y la encontró un test.)*

### El vendedor no ve su riesgo

Decirle "sos riesgo alto por estas cinco razones" es entregarle el mapa exacto
de qué evitar. Quien está intentando defraudar es quien más provecho le saca.

Lo que sí ve son sus **límites**, que son concretos y accionables.

---

## Límites, no bloqueos

Un vendedor en riesgo alto **puede vender**. Con techo, pero puede.

| Nivel | Órdenes/día | Monto/día |
|---|---|---|
| Bajo | sin techo | sin techo |
| Medio | 50 | $50.000 |
| Alto | 10 | $10.000 |

Configurables por variable de entorno (`SELLER_LIMIT_*`). Un
`if (ordenes > 10)` dentro del servicio de órdenes sería imposible de ajustar
sin desplegar, e imposible de encontrar cuando alguien pregunte por qué a un
vendedor le rebotó una venta.

**Frenar automáticamente por señales indirectas dejaría sin facturar a gente
honesta** que cambió de teléfono o que tuvo un vivo que salió muy bien. Lo que
frena de verdad es una suspensión, y esa la decide una persona.

Los números son criterio, no medición: todavía no hay historial del cual
sacarlos. Se revisan cuando lo haya.

---

## Cambios críticos

Cambiar la cuenta de cobro o el teléfono principal **invalida la confianza
previa**: el patrón de una cuenta comprada o robada es entrar y cambiar dónde se
cobra.

Quedan auditados y suben el riesgo a alto durante 7 días.

> ⚠️ **Enviar la verificación por primera vez NO es un cambio crítico**, y
> estuvo en la lista. Con ese evento adentro, el primer envío dejaba al vendedor
> en riesgo alto: intentar verificarse empeoraba su situación durante una
> semana, exactamente al revés de lo que el sistema debería incentivar. Lo
> encontró un test de integración.

---

## Endpoints

```
GET  /api/v1/sellers/verification          estado propio (enmascarado)
POST /api/v1/sellers/verification          enviar datos — 5 por hora

POST /api/v1/admin/sellers/:id/verification/take       tomar para revisar
POST /api/v1/admin/sellers/:id/verification/approve    con motivo
POST /api/v1/admin/sellers/:id/verification/reject     con motivo
POST /api/v1/admin/sellers/:id/risk/recompute
```

El panel muestra el nivel de riesgo, los motivos, y la verificación enmascarada
en `/vendedores/<id>`.

---

## Mercado Pago marketplace

`SellerPaymentAccount` ya existe con `credentialRef` — **una referencia, no el
token**. Esa parte del diseño ya estaba bien.

El OAuth por vendedor no está implementado: depende de habilitación externa. Lo
que hay son los estados (`NOT_CONNECTED`, `CONNECTED`, `EXPIRED`, `REVOKED`) y
la señal de riesgo que los usa. No se finge que la integración está operativa.

---

## Deuda

1. **Clave del HMAC compartida con `JWT_SECRET`.** Rotarla invalida la detección
   de duplicados.
2. **Sin subida de documentos.** La "verificación manual" hoy es un admin
   mirando datos declarados. Cuando haya subida de imágenes, el almacenamiento
   ya existe (R2, bucket privado).
3. **Los umbrales son criterio, no medición.**
4. **Sin liveness ni selfie.** Requiere proveedor externo.
5. **Los límites no están enganchados a la creación de órdenes todavía.**
   `RiskService.puedeRecibirOrden()` está escrito y probado, falta llamarlo
   desde `OrdersService`. Se hace junto con Live Sessions, que es cuando el
   volumen empieza a importar.
6. **OAuth de Mercado Pago por vendedor** pendiente de habilitación externa.
