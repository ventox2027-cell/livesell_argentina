# SPRINT 0B · Procedimiento de campo — Mercado Pago

> **La pregunta que esta prueba tiene que responder:**
> ¿Podemos cobrar con tarjeta desde la app, sin que los datos de la tarjeta
> pasen por nuestros sistemas, y sobrevive el flujo a que se corte la red en el
> peor momento?
>
> Si la respuesta es no, no hay proyecto. Es el riesgo **R1**.

---

## 0 · Antes de empezar

| Requisito | Cómo se verifica |
|---|---|
| Docker con PostgreSQL y Redis | `docker ps` muestra `livesell-postgres` y `livesell-redis` sanos |
| Backend en el aire | `curl http://localhost:3100/health` → `{"status":"ok"}` |
| Túnel público arriba | `curl https://<tunel>/health` responde lo mismo |
| Credenciales de PRUEBA cargadas | El backend arranca. Si el token no empieza con `TEST-`, no arranca a propósito |
| Webhook configurado en el panel | La URL del túnel + evento **Pagos**, y la clave secreta en `.env` |
| APK instalado en el teléfono | Con la pantalla "PROBAR UN PAGO" |

⚠️ **El túnel de Cloudflare cambia de URL cada vez que se reinicia.** Si eso
pasa hay que actualizarla en dos lugares: el panel de Mercado Pago y
`MP_NOTIFICATION_URL` del `.env`. Es la causa número uno de "el webhook no
llega".

---

## 1 · Tarjetas de prueba (Argentina)

| Marca | Número | CVV | Vencimiento |
|---|---|---|---|
| Visa | `4509 9535 6623 3704` | 123 | 11/30 |
| Mastercard | `5031 7557 3453 0604` | 123 | 11/30 |
| American Express | `3711 8030 3257 522` | 1234 | 11/30 |
| Visa débito | `4002 7686 9439 5619` | 123 | 11/30 |

**Documento:** DNI `12345678`

### El nombre del titular decide el resultado

Esto es lo que hace que la prueba sea buena: **el resultado del cobro se
controla escribiendo un nombre distinto**, con la misma tarjeta. No hace falta
inventar escenarios ni esperar que algo salga mal.

| Nombre del titular | Qué pasa |
|---|---|
| `APRO` | Aprobado |
| `FUND` | Rechazado por fondos insuficientes |
| `SECU` | Código de seguridad inválido |
| `EXPI` | Fecha de vencimiento inválida |
| `CALL` | Requiere autorización del banco |
| `CONT` | Queda pendiente |
| `LOCK` | Tarjeta inhabilitada |
| `DUPL` | Pago duplicado |
| `OTHE` | Error general |

---

## 2 · Configurar el teléfono

1. Instalá el APK desde `http://192.168.0.14:8099` (con el `http://` adelante).
2. Abrí la app → **Configuración del backend**.
3. Pegá la URL del túnel: `https://<tunel>.trycloudflare.com`
   No la IP local: el webhook y la tokenización necesitan HTTPS público.
4. Volvé al inicio → **PROBAR UN PAGO** (botón índigo).

---

## 3 · Primera compra

| # | Paso | Qué observar | ✅/❌ |
|---|---|---|---|
| 1 | Toque en **Comprar** | Se crea la orden y abre el formulario | |
| 2 | El formulario carga | Los campos de tarjeta son **iframes de Mercado Pago** | |
| 3 | Cargar Visa + `APRO` + DNI `12345678` | Aparecen banco emisor y cuotas solos | |
| 4 | **Pagar** | Overlay "Procesando el pago" | |
| 5 | Resultado | **✅ Pago acreditado** | |
| 6 | Webhook | Ver el registro (consulta abajo) | |
| 7 | Firma verificada | `signature_valid = t` | |
| 8 | Estado final | Orden en `PAID` | |
| | **Tiempo total** | objetivo: menos de 60 s | |

### Verificación en la base

```bash
docker exec -i livesell-postgres psql -U livesell -d livesell -c "
SELECT o.id, o.status, o.amount_cents, p.mp_payment_id, p.status AS pago,
       p.card_last_four, p.status_detail
FROM spike_orders o LEFT JOIN spike_payments p ON p.order_id = o.id
ORDER BY o.created_at DESC LIMIT 3;"
```

```bash
docker exec -i livesell-postgres psql -U livesell -d livesell -c "
SELECT to_char(received_at,'HH24:MI:SS') AS hora, resource_id,
       signature_valid, COALESCE(rejection_reason,'—') AS motivo
FROM mp_webhook_events ORDER BY received_at DESC LIMIT 5;"
```

### ⛔ La verificación que de verdad importa

**Que no haya ni un dato de tarjeta en ningún lado.** Es lo que sostiene el
alcance PCI SAQ-A. Si esto falla, el resultado del spike es NO-GO por más que
el cobro funcione.

```bash
docker exec -i livesell-postgres psql -U livesell -d livesell -c "
SELECT count(*) AS filas_con_datos_de_tarjeta
FROM spike_payments
WHERE raw_response::text ~* '(cardholder|first_six|security_code|\"token\")';"
```

Tiene que dar **0**. Cualquier otro número es un incidente.

---

## 4 · Casos de rechazo

Misma tarjeta, sólo cambia el nombre del titular. Lo que se evalúa no es que
Mercado Pago rechace —eso ya sabemos que funciona— sino **que la app le diga
a la persona algo que se entienda** y que la orden quede en un estado que
permita reintentar.

| Titular | Estado esperado de la orden | Mensaje útil | ✅/❌ |
|---|---|---|---|
| `FUND` | `FAILED` | | |
| `SECU` | `FAILED` | | |
| `CALL` | `FAILED` | | |
| `CONT` | `PROCESSING` | | |

Después de un `FAILED`, **"Reintentar el pago" con `APRO` tiene que funcionar**.
Si la orden queda trabada, la máquina de estados está mal.

---

## 5 · Robustez — el corazón del spike

Los tests automáticos ya cubren esto contra un doble de Mercado Pago
(`test/integration/payments-flow.spec.ts`, 20 casos). Acá se confirma contra el
Mercado Pago de verdad.

| # | Prueba | Cómo se hace | Esperado | ✅/❌ |
|---|---|---|---|---|
| P1 | Doble toque en Pagar | Tocar dos veces rápido | Un solo cobro | |
| P2 | Webhook duplicado | Reenviar la misma notificación | Una sola acreditación | |
| P3 | Firma inválida | Ver §6 | Rechazado y registrado | |
| P4 | Reenvío de notificación vieja | Ver §6 | `STALE_TIMESTAMP` | |
| P5 | **Webhook perdido** | Bajar el túnel, pagar, subirlo, **Conciliar** | La orden llega a `PAID` igual | |
| P6 | Corte de red al pagar | Modo avión justo tras tocar Pagar | Queda `PROCESSING`, **nunca** `FAILED` | |

**P5 y P6 son las que separan una integración seria de una que pierde plata.**

En P6 lo que se verifica es que la app **no diga "rechazado"** cuando en
realidad no sabe. Si dijera eso, la persona pagaría otra vez y quedaría
cobrada dos veces por un producto.

---

## 6 · Ataques al webhook

Se corren desde la terminal, no desde el teléfono.

```bash
cd backend
URL="https://<tunel>.trycloudflare.com/webhooks/mercadopago"
SECRET=$(grep '^MP_WEBHOOK_SECRET=' .env | cut -d= -f2-)
firmar() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$2" -hex | sed 's/^.*= //'; }

# Firma falsa → HASH_MISMATCH
TS=$(date +%s); M="id:999;request-id:req-falso;ts:${TS};"
curl -s -X POST "${URL}?data.id=999&type=payment" \
  -H "content-type: application/json" -H "x-request-id: req-falso" \
  -H "x-signature: ts=${TS},v1=$(firmar "$M" clave-de-un-atacante)" \
  -d '{"id":"n1","type":"payment","data":{"id":"999"}}'

# Reenvío de hace 20 minutos → STALE_TIMESTAMP
TS=$(( $(date +%s) - 1200 )); M="id:888;request-id:req-viejo;ts:${TS};"
curl -s -X POST "${URL}?data.id=888&type=payment" \
  -H "content-type: application/json" -H "x-request-id: req-viejo" \
  -H "x-signature: ts=${TS},v1=$(firmar "$M" "$SECRET")" \
  -d '{"id":"n2","type":"payment","data":{"id":"888"}}'
```

Los dos tienen que responder `{"received":false,"status":"INVALID_SIGNATURE"}`
con HTTP 200 — **200 a propósito**: un 401 haría que Mercado Pago reintentara
en bucle algo que nunca vamos a aceptar.

---

## 7 · Criterio PASS/FAIL

**GO** si se cumplen las cinco:

1. Una compra con tarjeta termina en `PAID` sin intervención manual.
2. **Cero datos de tarjeta** en base y logs.
3. El webhook valida firma y **rechaza** las inválidas y las viejas.
4. Un webhook duplicado **no** acredita dos veces.
5. Una orden con el webhook perdido se resuelve por conciliación.

**NO-GO** si aparece cualquiera de estas:

- Algún dato de tarjeta llega a nuestros sistemas.
- Un timeout deja la orden en `FAILED` en vez de `PROCESSING`.
- Un webhook duplicado acredita dos veces.

**GO CON RESERVA** si todo funciona pero la experiencia no cierra: demasiados
pasos, mensajes de error que no se entienden, o el formulario tarda de más.

---

## 8 · Al terminar

Completar la sección `0B` de [RESULTS.md](RESULTS.md) **durante** la prueba, no
después de memoria. Es la evidencia de la decisión, y una tabla llena a la
noche del día siguiente no es evidencia de nada.
