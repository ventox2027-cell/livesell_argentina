# Informe — segunda tanda

**Desde** `f733bc1` **hasta** `c0c813a` · 3 commits · 52 archivos · +4173 líneas

```
backend:  1053 → 1136 tests · lint limpio · typecheck limpio
mobile:    183 →  202 tests · analyze limpio
APK:      15/08 00:27 · arm64 sha256 6a989b12 · arm32 sha256 b733a2ad
backend:  recompilado 15/08 00:25  ⚠️ hay que reiniciarlo
```

---

## Lo primero, porque bloquea todo lo demás

**Reiniciá el backend.** El `dist/` está compilado a las 00:25 con los cuatro
bloques de abajo. La APK sola no alcanza: la regla de 18+, el bloqueo de compra
sin Mercado Pago, el cifrado del código de entrega y la exportación de datos
viven todos del lado del servidor.

Ya pasó una vez en esta sesión —el backend corría un `dist/` de diez horas
antes— y el síntoma fue "Cobros no está habilitado en este servidor", que no
tenía nada que ver con Cobros.

---

## 1 · Sin Mercado Pago conectado no se vende

**`f8596c9`**

La regla ya estaba escrita y probada como función pura. Lo que faltaba era
enchufarla en el último lugar: **la creación de la orden**.

### El agujero

Un producto publicado *antes* de que existiera la regla —o de un vendedor que
desconectó su cuenta después— seguía siendo comprable. Ese cobro entraba en la
cuenta de VendoX.

No se rompen los productos históricos a propósito: siguen publicados. Lo que se
corta es la compra, en el primer momento en que se sabe. Cortar recién al cobrar
sería peor: la persona aparta stock, carga su dirección, entra el número de
tarjeta y recién ahí se entera, dejando además una orden huérfana y unidades
reservadas por una compra que nunca podía completarse.

### El mensaje al comprador es otro

Es el error más fácil de cometer acá: reusar el texto de "conectá tu cuenta de
Mercado Pago" en un endpoint que lee alguien que no tiene ninguna cuenta que
conectar y no hizo nada mal.

> Este vendedor no está pudiendo recibir pagos en este momento. Probá más tarde
> o escribile para avisarle.

Hay un test que falla si ese mensaje llega a contener "conectar tu cuenta".

### El campo que hacía dudar

`obligatoriaParaVender` valía `false` para un vendedor **ya conectado**. Leído
desde afuera parecía decir que Mercado Pago no era obligatorio — cuando sí lo
es. El valor era correcto y el nombre, malo.

Ahora son tres campos porque son tres preguntas distintas:

| Campo | Pregunta |
|---|---|
| `mercadoPagoObligatorio` | ¿Este servidor exige Mercado Pago? Es la **regla**. |
| `puedeVender` | ¿Este vendedor puede publicar y transmitir **ahora**? |
| `faltaConectar` | ¿Le falta conectarla? Es la llamada a la acción. |

Los contratos de la app se capturan de respuestas reales del servidor
(`test/contratos/cobros-*.json`), no se escriben a mano. Ya pasó una vez que un
JSON inventado pasaba en verde mientras la app mostraba `$0,00`.

### Verificación por sabotaje

Anular el bloqueo → **4 tests caen**: publicar, pasar borrador a publicado,
iniciar vivo, crear orden.

---

## 2 · El código de entrega ya no se guarda en claro

**`f8596c9`**

Pediste guardar un hash "si la implementación actual lo permite". **No lo
permite, y no es una decisión de seguridad: es que el sistema dejaría de
funcionar.**

El comprador tiene que poder *leer* su código cada vez que abre el pedido. No es
una contraseña que se memoriza: es un número que se dice en la puerta cuando
llega el repartidor, quizás días después. Con hash habría que mostrarlo una sola
vez y que lo pierda quien reinstale la app o cambie de teléfono.

Lo que sí se puede es **cifrarlo**, y la infraestructura ya existía para los
tokens de Mercado Pago. La columna ahora guarda `v1.iv.tag.ciphertext` con la
llave en una variable de entorno, fuera de la base.

### Qué gana y qué no

**Gana:** un respaldo, una réplica o un volcado que alguien hizo para depurar
dejan de contener códigos utilizables.

**No gana:** quien tenga acceso al proceso puede descifrar. Y la amenaza
principal sigue siendo otra —un vendedor marcando entregas que no hizo— contra
la que lo que protege es que él nunca lo ve, no el cifrado.

**El precio, y hay que saberlo:** si se pierde `CREDENTIALS_ENCRYPTION_KEY`, los
códigos en curso no se pueden leer ni verificar. Es la misma llave que cifra los
tokens de Mercado Pago, así que perderla ya era un incidente mayor.

### Compatibilidad hacia atrás

Los pedidos despachados antes tienen seis dígitos en claro. **No se migran**: en
dos semanas no queda ninguno sin entregar, y un script que cifra filas puede
fallar a la mitad y dejar pedidos que nadie puede confirmar. La restricción de
la base acepta las dos formas.

Un detalle que se corrigió sobre la marcha: la primera versión devolvía tal cual
cualquier cosa que no empezara con `v1.`. Eso significa que un valor corrupto
salía de ahí como si fuera un código válido. Ahora sólo se acepta lo que tiene
la forma exacta de lo legado —seis dígitos— y todo lo demás **tiene** que ser un
sobre.

### Y dos cosas de la interfaz

- Después de entregado el código **no vuelve a salir del backend**, y en su
  lugar la app muestra «Entrega confirmada». Un secreto inútil a la vista en una
  pantalla que se vuelve a abrir para calificar no gana nada.
- El botón de confirmar queda **deshabilitado hasta tener los seis dígitos**.
  Dejarlo activo para después responder "son seis números" es hacer que la
  persona descubra la regla equivocándose, con el repartidor en la puerta.

Lo demás del módulo ya estaba bien y no se tocó: `randomInt`, ceros a la
izquierda, un solo uso, cinco intentos, bloqueo de 30 minutos, comparación en
tiempo constante, el vendedor nunca lo ve, no aparece en logs.

### Verificación por sabotaje

Guardar en claro → **8 tests caen**. Seguir mostrándolo tras la entrega → **1**.

---

## 3 · VendoX es 18+

**`22e959f`**

La regla estaba decidida desde el principio y **no existía en ninguna parte del
sistema**: ni una columna, ni una validación, ni una pantalla. Un chico de
catorce podía comprar y abrir una tienda.

Era el hueco más grande de las colas pendientes.

### Por qué 18

No es una preferencia de producto. En Argentina la capacidad para contratar se
adquiere a los 18 (CCyC art. 25 y 26). Una compra es un contrato; una venta con
comprobantes, cuenta bancaria y responsabilidad fiscal lo es mucho más.

### Es declarada, y eso se dice en voz alta

La fecha la escribe la persona. No hay integración con RENAPER —montarla es
contratar un servicio— así que alguien decidido puede mentir.

Lo que sí logra: deja constancia de que se preguntó y de qué se respondió, que
es lo que mueve la responsabilidad a quien declaró en falso; frena al que no está
mintiendo, que es la mayoría; y deja el dato listo para el día que exista el
proveedor real.

**Hay un test que falla si la interfaz llega a decir en algún lado que la edad
está "verificada".** No lo está.

### Dónde se pregunta

No al registrarse. Meter un formulario entre "Continuar con Google" y el primer
video es la forma más cara de perder a alguien que todavía no sabe si la app le
sirve. Se pregunta **antes de comprar** y **antes de crear la tienda**, que es el
mismo criterio con el que ya se pide el teléfono. Mirar un vivo no requiere nada.

### Se declara una sola vez

Si se pudiera editar, la regla no existiría: alguien pone una fecha, la app lo
frena, y vuelve a la pantalla a poner otra. Sería un formulario que enseña cuál
es la respuesta correcta.

Corregir un error genuino pasa por soporte. **Y la pantalla lo avisa antes de que
escriba, no en el error**: una regla que se descubre después de equivocarse es
una trampa.

### Detalles que costaron trabajo y no se ven

- `DATE` y no `timestamp`. En un país a UTC-3, `2008-03-15T00:00:00Z` leído en
  local es el 14, y alguien cumple años un día tarde.
- El día del cumpleaños ya cuenta. Comparar sólo el año le daría 18 a quien nació
  en diciembre desde el 1 de enero.
- El 29 de febrero cumple el 1 de marzo en los años no bisiestos.
- `2008-02-31` no se convierte en 2 de marzo: se rechaza.
- `15/03/2008` se rechaza en el DTO. `new Date('15/03/2008')` da resultados
  distintos según el servidor.
- El CHECK de la base usa límites **fijos**: `CURRENT_DATE` no es `IMMUTABLE` y
  PostgreSQL lo rechaza, y además rompería una restauración hecha en otra fecha.
- "Revisá el año" y "tenés que ser mayor de 18" son dos rechazos distintos con
  dos mensajes distintos. Confundirlos hace que alguien que se equivocó de año
  crea que la app lo está acusando de menor.
- `UNDERAGE` devuelve **403 y no 422**: a diferencia del resto, no se resuelve
  completando un formulario. Un 422 haría que la app lo abriera en un bucle.

### Verificación por sabotaje

Anular el bloqueo → **5 tests de integración caen**.

---

## 4 · Los datos son de la persona

**`c0c813a`**

Los dos derechos que la Ley 25.326 obliga a dar: acceder a los propios datos
(art. 14) e irse (art. 16). Ninguno estaba resuelto de verdad.

### Un vendedor podía cobrar y desaparecer

Cerrar la cuenta era un `DELETE` sin condiciones. Diez pedidos cobrados,
"eliminar cuenta", y del otro lado diez personas con la plata puesta esperando
algo que nunca iba a llegar, contra una cuenta anonimizada sin forma de
contactar a nadie.

No es hipotético. Es la forma más barata de estafar en una plataforma de venta y
no requiere saber nada de tecnología.

Ahora el cierre se bloquea mientras haya pedidos en curso, como comprador o como
vendedor, y el mensaje dice cuántos son y qué hacer. **El bloqueo es temporal y
explicado, no una retención:** convertir "tenés un pedido en camino" en "no te
podés ir nunca" sería usar una regla legítima para atrapar gente. Un carrito sin
pagar no frena nada.

Tres cosas más aparecieron mirando esto:

- **El orden estaba al revés.** Se cerraban todas las sesiones y *después* se
  intentaba cerrar la cuenta. Desde que el cierre puede fallar, eso dejaba a la
  persona expulsada de todos sus dispositivos con la cuenta viva.
- **La app borraba la sesión local igual.** `ApiClient` valida `status < 500`,
  así que un 409 volvía como éxito y mostraba "tu cuenta fue eliminada" sobre
  una cuenta intacta.
- **La fecha de nacimiento sobrevivía a la anonimización.** Sola no identifica a
  nadie; cruzada con las órdenes —que quedan, con la dirección de entrega
  adentro— sí.

### "Dame todo lo que tenés sobre mí"

`GET /auth/me/export`, y en la app: Perfil → **Descargar mis datos**. Sin esto,
cada pedido de acceso lo resuelve alguien del equipo con una consulta SQL, que es
exactamente la forma de que salga lo que no corresponde.

Lo que **no** sale, y cada uno tiene un test que falla si se filtra:

- **Datos de otra gente.** Un vendedor se lleva el registro de sus ventas —qué
  vendió, en cuánto, cuánto cobró— pero **no la dirección de entrega de quien le
  compró**. Es el error clásico del "exportá todo lo relacionado": un `include`
  de más y cada vendedor se baja el domicilio de todos sus clientes en un
  archivo.
- Ningún token: ni de Mercado Pago, ni de sesión, ni de push.
- El `subject` del proveedor de identidad. A la persona no le sirve y a quien le
  robe el archivo le sirve muchísimo.
- El hash del documento ni el nivel de riesgo. El primero no le sirve; el
  segundo es una evaluación interna y publicarla enseña a esquivarla.

Va inline y no por correo porque no hay cola dedicada ni correo transaccional
configurado, y montarlos para esto sería construir dos cosas para entregar una. A
cambio se limita a mil filas por colección y **se dice cuántas quedaron afuera**:
devolver mil pedidos de tres mil como si fueran todos sería contestar el pedido
de acceso con un archivo incompleto que parece completo.

Queda registrado en la bitácora quién exportó y cuándo. Si el archivo aparece
filtrado, es el único rastro que va a quedar.

### Verificación por sabotaje

Filtrar la dirección en la exportación del vendedor y anular la comprobación de
cierre → **4 tests caen**.

---

## Errores propios que aparecieron y se corrigieron

| Qué | Cómo se detectó |
|---|---|
| El repo quedó sin compilar: `OrdersService` llamaba a un servicio no inyectado | `typecheck` |
| `LiveKitService` mockeado con `vi.fn()` pelado reventaba con un 500 sin relación con el test | El test nuevo de vivo |
| Los asserts leían `body.code` en vez de `body.error.code` | 5 tests en rojo |
| `leerCodigoGuardado` devolvía tal cual cualquier valor corrupto | Test de sobres mal formados |
| El backtick de un comentario se lo comió el shell, otra vez | Revisión del archivo |
| Un `as OrderStatus` innecesario | `lint` |

Y la de siempre: `node -e` con comillas se come las barras invertidas y los
backticks. Todo lo que lleva `\` o `` ` `` va con la herramienta de edición, no
por shell.

---

## Estado de las colas

**Cerrado en esta tanda:** el bloqueo de Mercado Pago completo (era lo último de
la primera cola), el código de entrega, 18+ y derechos sobre los datos.

**Queda de la segunda cola:** Admin Lite V2 · analítica del vendedor ·
categorías · endurecer checkout · seguridad de sesión · cambios críticos del
vendedor · favoritos · deep links · UX de error · offline · accesibilidad ·
performance · observabilidad · separación de workers · retención · página de
tienda · onboarding · home del vendedor · timelines · WhatsApp/email · flags ·
E2E · caos.

**Y la tercera entera**, que es la de desplegar: staging, CI, runbooks, índices,
prueba de carga, `BETA_READINESS.md`.

### Lo que yo haría ahora

1. **Reiniciar el backend** y probar los cuatro bloques en el teléfono.
2. **Seguridad de sesión y cambios críticos del vendedor** — avisar cuando se
   desconecta Mercado Pago o entra un dispositivo nuevo. Con plata de por medio,
   es prevención de fraude, no una comodidad.
3. **Observabilidad y `BETA_READINESS.md`** — antes de la beta hay que poder ver
   qué pasa cuando algo se rompe.

Si preferís otro orden, decímelo y arranco por ahí.
