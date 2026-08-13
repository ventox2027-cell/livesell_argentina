# 15 — Checklist de lanzamiento

Cubre: **§33 Checklist de lanzamiento**

> Regla: **ningún punto se marca por acuerdo verbal.** Cada casilla necesita evidencia — una captura, una traza, un test verde o un log. Si nadie lo probó, no está hecho.

---

## 0. Bloqueantes absolutos

Si alguno de estos cinco falla, **no se lanza**. No hay excepciones ni "lo arreglamos el lunes".

- [ ] **Una compra real, con dinero real, de punta a punta, en producción.**
- [ ] **300 compras concurrentes sobre 2 unidades → exactamente 2 órdenes.** Cero sobreventa.
- [ ] **Doble toque en "Pagar" → un solo cobro.** Probado también con red que pierde respuestas.
- [ ] **Un vendedor transmite 60 minutos en 4G real sin caída visible.**
- [ ] **El video no se pausa durante el checkout.** Verificado en dispositivo, no solo en test.

---

## 1. Trámites y cuentas

- [ ] Cuenta de **producción** de Mercado Pago aprobada y operativa.
- [ ] Cuenta de Apple Developer activa.
- [ ] Cuenta de Google Play Console activa.
- [ ] Plan de LiveKit Cloud contratado, con cuota suficiente confirmada por escrito.
- [ ] Dominios registrados y DNS en Cloudflare: `api` · `cdn` · `staging`.
- [ ] Certificados TLS activos con renovación automática.
- [ ] Facturación configurada en los 4 proveedores, con **alertas de gasto**.

## 2. Streaming

- [ ] Latencia p95 medida **desde Argentina** por debajo de 800 ms en WebRTC, con las 4 operadoras.
- [ ] Conmutación WebRTC → LL-HLS verificada sin parpadeo ni corte de audio.
- [ ] Desborde automático probado superando el umbral de espectadores.
- [ ] Reconexión del emisor a los 20, 60 y 120 s (dentro y fuera de la ventana de gracia).
- [ ] **Durante `RECONNECTING`, el chat y la compra siguen funcionando.**
- [ ] Cambio WiFi → 4G y 4G → WiFi sin matar el live.
- [ ] Modo solo audio funcionando con red degradada.
- [ ] Grabación a R2 verificada, con el VOD reproducible.
- [ ] Presupuesto por live con alarma al 80 % y al 100 %.
- [ ] Consumo de batería del feed medido: **menos del 12 % por hora** en gama media.
- [ ] 40 deslizamientos en el feed sin fuga de reproductores ni audio de fondo.

## 3. Inventario y órdenes

- [ ] `inventory-concurrency.spec.ts` completo en verde contra Postgres real.
- [ ] `k6`: 1.000 compras concurrentes sobre 100 unidades → exactamente 100 órdenes.
- [ ] Reserva vencida devuelve el stock en menos de 2 s.
- [ ] El barrido de red de seguridad corre cada 30 s y recupera reservas huérfanas.
- [ ] Doble liberación no infla el stock.
- [ ] Commit de reserva expirada falla y **no** altera el inventario.
- [ ] Un ajuste a la baja por debajo de lo reservado es rechazado con mensaje claro.
- [ ] Reinicio de Redis durante un live: el stock sigue correcto (vive en Postgres).
- [ ] `inventory_negative_available_total` en 0 tras la prueba de carga.
- [ ] Máquina de estados: toda transición inválida tira excepción, ninguna se escribe.

## 4. Pagos

- [ ] Compra real con tarjeta real, en producción.
- [ ] **Segunda compra en 2 clics**, con tarjeta guardada, en menos de 10 s.
- [ ] Cuotas mostrando importe y CFTEA correctos.
- [ ] Firma de webhook verificada: una firma inválida devuelve 401.
- [ ] Webhook duplicado → una sola acreditación (verificado en `inventory_movements`).
- [ ] Webhooks fuera de orden resueltos correctamente.
- [ ] Webhook perdido a propósito → conciliado en menos de 5 min.
- [ ] Timeout de red con MP → el pago queda `PENDING`, **nunca `REJECTED`**.
- [ ] Rechazo con `call_for_authorize` muestra el mensaje accionable, no "Error".
- [ ] Reembolso real probado, con devolución de stock si no se despachó.
- [ ] **Los datos de tarjeta no aparecen en logs, Sentry ni base** (verificado por búsqueda de texto).
- [ ] Pedido `PAID_WITHOUT_STOCK` dispara alerta y queda para revisión manual.

## 5. Tiempo real

- [ ] `PRODUCT_FEATURED` llega a todos los espectadores en menos de 250 ms.
- [ ] Un solo producto destacado a la vez (probado con doble toque rápido).
- [ ] `STOCK_UPDATED` agrupado: 8 cambios en 500 ms producen 1 evento.
- [ ] Reacciones: 10.000 eventos/s de entrada → 2 eventos/s de salida por cliente.
- [ ] Reconexión de WS resincroniza con `GET /lives/{id}/state`.
- [ ] Un hueco en `seq` dispara resincronización, no estado inconsistente.
- [ ] 3 instancias de API: un cliente en la instancia 1 recibe eventos emitidos desde la 3.
- [ ] Un worker sin conexiones emite correctamente por el adaptador de Redis.
- [ ] Límite de 5 conexiones por usuario funcionando.

## 6. Notificaciones

- [ ] Push Tipo B entregado en menos de 45 s al 90 % de una flota de 10 dispositivos reales.
- [ ] **Sonido personalizado verificado en dispositivo físico** (iOS y Android).
- [ ] Canal `live_alerts` con heads-up en Android 13, 14 y 15.
- [ ] `interruption-level: time-sensitive` atraviesa el modo Concentración en iOS.
- [ ] **Sin Critical Alerts de Apple** (confirmado en el payload).
- [ ] `ttl: 900s` verificado: un teléfono apagado 20 min no recibe el aviso.
- [ ] Tipo A agrupa 4 publicaciones en 30 min en una sola notificación.
- [ ] Deduplicación: reprocesar el evento no genera un segundo push.
- [ ] Horario de silencio respetado y saltado correctamente por `is_favorite`.
- [ ] Deep link abre el live **con la app cerrada**.
- [ ] Tokens `UNREGISTERED` se eliminan en el momento.
- [ ] Fan-out con jitter probado con 100.000 destinatarios simulados.

## 7. Onboarding y compra

- [ ] Registro con Google en menos de 15 s.
- [ ] Registro con Apple funcionando (obligatorio si hay Google).
- [ ] **No se pide DNI ni dirección en el registro.**
- [ ] El permiso de push se pide al seguir, no al arrancar.
- [ ] Formulario de dirección en **una sola pantalla**.
- [ ] Autocompletado de CP resuelve provincia y ciudad en las 24 jurisdicciones.
- [ ] Validación de CUIL rechaza dígito verificador inválido, **al teclear**.
- [ ] CP en formato clásico (`1414`) y CPA (`C1414AAJ`) se normalizan al mismo núcleo.
- [ ] Primera compra completa en menos de 90 s.
- [ ] Geocodificación caída → **la compra se completa igual**.

## 8. Buscador y feed

- [ ] El nombre de un vendedor lo devuelve primero.
- [ ] Un live aparece en el carrusel en menos de 5 s desde que arranca.
- [ ] Buscar "remeras" **no** devuelve un live de gorras solo por estar en vivo.
- [ ] "camion" encuentra "camión"; "capera" encuentra "campera".
- [ ] Un vendedor con 400 productos no monopoliza la primera página.
- [ ] Autocompletado en menos de 120 ms p95.
- [ ] Búsqueda sin resultados muestra sugerencias, no una pantalla vacía.
- [ ] Feed prioriza lives activos y considera a los vendedores seguidos.

## 9. Seguridad

- [ ] `gitleaks` limpio en **todo el historial** de git.
- [ ] `pnpm audit` sin vulnerabilidades altas o críticas.
- [ ] Test de redacción: datos personales no aparecen en logs ni en Sentry.
- [ ] Detección de reuso de refresh token: revoca la familia completa.
- [ ] Un vendedor no puede leer ni editar recursos de otro (probado).
- [ ] Rate limiting activo en auth, órdenes, pagos y direcciones.
- [ ] `.strict()` en los esquemas Zod: una propiedad extra es rechazada.
- [ ] `$queryRawUnsafe` prohibido por lint en todo el repositorio.
- [ ] **DNI cifrado en la base**: la columna es ilegible sin la clave.
- [ ] Alerta ante lecturas masivas de `user_addresses`.
- [ ] Certificate pinning probado con un proxy interceptor.
- [ ] WAF de Cloudflare activo.
- [ ] APK ofuscado, con símbolos de depuración subidos a Sentry.
- [ ] Ningún secreto en la imagen de Docker (verificado con `docker history`).

## 10. Observabilidad y operación

- [ ] Los 5 tableros de Grafana creados y con datos.
- [ ] `traceId` propagado desde Flutter hasta Mercado Pago en una traza real.
- [ ] Sentry recibiendo errores de backend y de la app, con `release` correcto.
- [ ] Errores de dominio esperados **filtrados** en Sentry.
- [ ] `/health` responde aunque Postgres esté caído.
- [ ] `/ready` devuelve 503 solo si fallan Postgres o Redis.
- [ ] Las 12 alertas configuradas y con destinatario.
- [ ] Guardia definida con nombres y teléfonos, no "el equipo".
- [ ] **Runbooks escritos y ensayados**: caída de LiveKit · caída de MP · saturación de Redis · Postgres al límite · live viral.
- [ ] Rollback probado de verdad: se desplegó una versión rota y se revirtió.
- [ ] Backup de Postgres verificado **restaurando**, no solo confirmando que existe.

## 11. Rendimiento

- [ ] p95 de la API por debajo de 300 ms en las rutas principales.
- [ ] `POST /orders` p95 por debajo de 400 ms.
- [ ] `k6`: 10.000 espectadores concurrentes con compras activas, sostenido 15 min.
- [ ] Sin fugas de memoria tras 1 h de prueba de carga.
- [ ] Conexiones de Postgres por debajo del 60 % en pico.
- [ ] Redis por debajo del 50 % de memoria en pico.
- [ ] Arranque en frío de la app por debajo de 2,5 s en gama media.
- [ ] Primer frame del feed en menos de 1,5 s.

## 12. Tiendas y legal

- [ ] Fichas completas: capturas, descripción, categoría, palabras clave.
- [ ] Política de privacidad publicada y enlazada.
- [ ] Términos y condiciones publicados.
- [ ] Formulario de datos de la App Store completo y **veraz**.
- [ ] Data Safety de Google Play completo.
- [ ] Justificación de permisos: cámara, micrófono, notificaciones.
- [ ] Flujo de eliminación de cuenta implementado (**requisito de ambas tiendas**).
- [ ] Cumplimiento de la Ley 25.326 de datos personales.
- [ ] Botón de arrepentimiento y régimen de defensa del consumidor contemplados.
- [ ] Build de prueba enviada en el Sprint 3 para detectar rechazos temprano.

## 13. Contenido de lanzamiento

Lo más importante y lo que más se olvida: **una plataforma de live shopping sin lives es una pantalla vacía.**

- [ ] **20–30 vendedores reclutados**, con la app instalada y probada.
- [ ] Cada uno con al menos 10 productos cargados, con fotos y peso.
- [ ] **Calendario de vivos lleno para la primera semana.**
- [ ] Al menos 3 vendedores hicieron una transmisión de prueba completa.
- [ ] Guía del vendedor escrita: cómo transmitir, cómo destacar, cómo despachar.
- [ ] Canal de soporte con alguien atendiendo.
- [ ] Al menos 5 compras de prueba reales completadas por gente ajena al equipo.

## 14. Plan del día del lanzamiento

| Momento | Acción |
|---|---|
| **T−7 días** | Congelamiento de funcionalidad. Solo correcciones |
| **T−3 días** | Prueba de carga final. Runbooks revisados |
| **T−1 día** | Backup verificado. Guardia confirmada. Rollback ensayado |
| **T−2 h** | Escalar la API a 4 instancias. Tableros en pantalla |
| **T−0** | Lanzar. Primer live agendado, no espontáneo |
| **T+1 h** | Revisar: errores, pagos, latencia, entrega de push |
| **T+24 h** | Retrospectiva. Primeras correcciones |

**Criterio de reversión:** si en las primeras 2 horas la tasa de error supera el 5 %, o falla más del 10 % de los pagos, o los espectadores no pueden ver el video, **se revierte y se comunica**. Revertir en la hora 1 cuesta una tarde; insistir con un sistema roto cuesta los vendedores.

---

## 15. Qué medir la primera semana

| Métrica | Objetivo | Si falla |
|---|---|---|
| Registro completado | > 80 % de quienes lo empiezan | Revisar OAuth y el paso de teléfono |
| Espectador → comprador | > 3 % | Revisar el embudo de la tarjeta destacada |
| **Primera compra completada** | **> 65 % de quienes abren el formulario** | El formulario está matando la conversión |
| Segunda compra en 2 clics | > 88 % | Algo se rompió en la tarjeta guardada |
| Éxito de pagos | > 95 % | Revisar rechazos por detalle |
| Apertura de push Tipo B | > 18 % | Revisar horario y redacción |
| Duración media de sesión de live | > 5 min | Revisar calidad de video y latencia |
| Crash-free users | > 99,5 % | Prioridad máxima |

**Los dos embudos de compra se miden por separado, siempre.** La primera compra y las siguientes son productos distintos: mezclarlas en una sola tasa de conversión oculta exactamente el problema que hay que vigilar.
