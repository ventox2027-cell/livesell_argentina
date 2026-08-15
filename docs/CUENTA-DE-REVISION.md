# La cuenta de revisión de Google Play

Qué es, por qué existe, cómo se arma y qué la hace segura.

---

## El problema

Quien revisa la app en Google Play necesita **credenciales que pueda tipear**.
VendoX no tiene registro con contraseña: se entra con Google o con Apple.

Las dos salidas obvias eran peores:

- **Darle una cuenta de Google real.** Google le pide verificación adicional
  cuando alguien entra desde otro país o desde un dispositivo nuevo — que es
  exactamente lo que hace un revisor. Y ata la revisión a la cuenta personal de
  alguien del equipo.
- **Habilitar `/auth/dev` en producción.** Eso sí es un agujero: emite sesiones
  válidas para cualquier email, sin verificar nada.

---

## La solución: `POST /auth/demo`

Un login con email y contraseña que **sólo puede autenticar cuentas marcadas
como demostración**.

### Las tres barreras

| # | Barrera | Qué impide |
|---|---|---|
| 1 | `DEMO_LOGIN_ENABLED` | Apagado, el endpoint responde 404. No existe. |
| 2 | `isDemoAccount` en el **WHERE** | Una cuenta sin la marca no se encuentra. No es que se rechace: la consulta no la devuelve. |
| 3 | CHECK en la base | `password_hash` sólo puede tener valor si `is_demo_account = true`. Ni siquiera se puede escribir un hash en una cuenta normal. |

La marca la pone **un script**, nunca la API. No hay ningún endpoint que escriba
`is_demo_account`.

### Qué pasa si alguien conoce la contraseña

Puede entrar a la cuenta de revisión. **A ninguna otra.** Hay un test que quita
el CHECK de la base, fuerza el estado imposible —una cuenta normal con el hash
correcto— y comprueba que el WHERE sigue frenando solo.

Y si eso pasa: se apaga `DEMO_LOGIN_ENABLED` y el camino desaparece sin
desplegar nada.

---

## Cómo armarla

### 1 · Crear la cuenta

En el servidor, con acceso a la base:

```bash
REVIEW_ACCOUNT_PASSWORD='...' node scripts/cuenta-de-revision.mjs
```

Mínimo 12 caracteres. **El script no imprime la contraseña nunca**, ni entera ni
recortada ni su largo. Lo único que dice es `contraseña: actualizada`.

Deja armado:

- el usuario `review@vendox.com.ar`, mayor de edad, con la marca de demostración;
- el perfil de vendedor en `ACTIVE`;
- la tienda «Tienda de demostración», con envío a precio fijo y retiro;
- tres productos publicados con stock;
- una dirección de entrega, para poder comprar.

Es **idempotente**: correrlo de nuevo sólo rota la contraseña. Sirve para eso.

> ⚠️ El comando queda en el historial del shell. Conviene limpiarlo después, o
> poner un espacio delante si el shell está configurado para ignorar esas líneas.

### 2 · Encender el interruptor

En el `.env` del servidor:

```
DEMO_LOGIN_ENABLED=true
```

Recompilar y reiniciar. Sin esto el endpoint responde 404.

### 3 · Mercado Pago de prueba

**Esto es lo que falta y necesita tu intervención.**

Sin Mercado Pago conectado, la cuenta de revisión **no puede publicar productos
ni iniciar un vivo** — es la regla de negocio, y no se hace una excepción para
esta cuenta.

Lo correcto es conectarla con credenciales de **prueba** de Mercado Pago:
el flujo funciona entero, con tarjetas de prueba, sin un peso real.

Qué hay que hacer, en el panel de Mercado Pago:

1. Entrar a **Tus integraciones** con la cuenta de VendoX.
2. En la aplicación de Marketplace, ir a **Credenciales de prueba**.
3. Crear dos **usuarios de prueba**: uno vendedor y uno comprador.
4. Cargar en el `.env` del servidor las credenciales de prueba —`MP_CLIENT_ID`,
   `MP_CLIENT_SECRET`, `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY`— **en lugar** de las
   productivas.
5. Desde la app, con la cuenta de revisión, tocar **Cobros → Conectar Mercado
   Pago** y autorizar con el usuario de prueba vendedor.

> ⛔ **Sandbox y producción no se mezclan.** Un `.env` con el `client_id`
> productivo y el `access_token` de prueba produce errores de autorización que
> parecen bugs de la app. O todo productivo, o todo de prueba.

> ⛔ La cuenta de revisión **nunca** puede cobrar a la cuenta productiva de
> VendoX. El fallback que hacía eso se eliminó y `ALLOW_PAYMENT_WITHOUT_SELLER_ACCOUNT`
> está prohibido fuera de desarrollo por el esquema de configuración.

---

## Qué ve el revisor

En la pantalla de bienvenida aparece **«Acceso de revisión»**, discreto, al lado
de «Configurar servidor». Sólo se muestra si el servidor tiene
`DEMO_LOGIN_ENABLED=true`.

El texto de la hoja dice explícitamente que es para quien revisa la app, y que
una persona usuaria tiene que entrar con Google o con Apple.

Con esa cuenta puede revisar:

| Función | ¿Se puede? |
|---|---|
| Ver el catálogo, buscar, entrar a una tienda | Sí |
| Ver un vivo, chatear, dar me gusta, compartir | Sí |
| Comprar (con tarjeta de prueba de MP) | Sí, con MP de prueba conectado |
| Ver sus pedidos, el código de entrega, calificar | Sí |
| Perfil, sesiones, descargar sus datos, eliminar cuenta | Sí |
| Mi tienda, productos, variantes, stock | Sí |
| Publicar un producto e iniciar un vivo | Sólo con MP conectado |
| Ventas, confirmar entrega, interesados, políticas | Sí |

---

## Límites y auditoría

- **Cinco intentos por hora y por IP.** No molesta a un revisor —entra una vez y
  se queda con la sesión— y convierte adivinar en algo que tarda años.
- Cada intento, exitoso o fallido, queda en `audit_logs` como
  `auth.demo_login_success` / `auth.demo_login_failed`, con IP y user-agent.
- **La contraseña no se registra en ningún lado.** Ni la correcta ni la que
  alguien tipeó mal — esa última es casi siempre la correcta con un carácter de
  diferencia.
- Un email inexistente y una contraseña equivocada devuelven **el mismo error**:
  responder distinto le diría a quien prueba qué cuentas existen.

---

## Rotar la contraseña

Volver a correr el script con la contraseña nueva. No hace falta nada más: las
sesiones abiertas siguen valiendo hasta que venzan, y si hay que cortarlas,
`POST /auth/logout-all` desde esa cuenta.
