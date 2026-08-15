# Seguridad de entorno

Qué separa la app que usa la gente de la que usamos nosotros, y cómo se
verifica que no se mezclen.

---

## Lo que se encontró

Tres cosas que viajaban en la APK y no debían.

| Qué | Dónde | Por qué importaba |
|---|---|---|
| **Herramientas del Sprint 0** | Perfil → Desarrollo | Una pantalla de medición de latencia de LiveKit adentro de una app de compras es lo que hace que una revisión de Google se detenga a preguntar qué es |
| **La URL del backend** | Perfil → Desarrollo | Le regala a cualquiera el objetivo a atacar sin tener que abrir la APK |
| **«Configurar servidor»** | Bienvenida | El peor de los tres: apunta la app al servidor que uno quiera. En un teléfono ajeno es redirigirla a un servidor propio y ver pasar todo |
| **`usesCleartextTraffic="true"`** | AndroidManifest | Habilitaba `http://` para toda la app. Con el botón de arriba al lado, era un camino completo de degradación a texto plano |

---

## Cómo quedó

### Dos ejes, no uno

La prueba de campo necesita las herramientas **y** el rendimiento de release: una
compilación de debug agrega decenas de milisegundos de intérprete y las
mediciones de latencia dejan de significar nada. Así que «release» y «con
herramientas» tienen que poder combinarse.

| Comando | Herramientas | Texto plano |
|---|---|---|
| `flutter run` | sí | sí |
| `flutter build apk --profile --dart-define=VENDOX_HERRAMIENTAS=true` | sí | sí |
| `flutter build apk --release` | **no** | **no** |

La APK que va a Google Play se compila con el último. **No hay forma de
encender las herramientas desde adentro**: es una constante de compilación
(`core/config/entorno.dart`), así que el compilador elimina las ramas y las
pantallas quedan inalcanzables.

Y eso se comprobó, no se supuso: al hornear un `--dart-define=SPIKE_API_KEY=…`
en una APK de release, el valor **no aparece en el binario**. Nada lo lee, así
que el compilador lo borró junto con las pantallas del spike.

### La política de red vive en un recurso

`android/app/src/{main,debug,profile}/res/xml/network_security_config.xml`.
Gradle superpone los recursos del tipo de compilación sobre los de `main`, así
que la política es una propiedad del binario y no una preferencia que se pueda
cambiar en el teléfono.

`main` —o sea release— sólo permite texto plano contra `10.0.2.2`, `127.0.0.1` y
`localhost`, que fuera de un emulador no llevan a ningún lado.

---

## El escáner de secretos

```bash
node tools/escanear-secretos.mjs
node tools/escanear-secretos.mjs --apk mobile/build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
node tools/escanear-secretos.mjs --bundle admin/.next
```

Sale con 1 si encuentra algo, así que sirve para un hook de pre-commit o para
CI.

### Tres lugares, tres riesgos

- **El repositorio.** Un secreto commiteado no se borra: queda en el historial y
  en cada copia que alguien clonó.
- **La APK.** Se descomprime con un doble clic. El código Dart va comprimido
  dentro del zip, así que el escáner **descomprime antes de mirar** — buscar
  sobre los bytes crudos no encuentra nada y da una sensación de seguridad
  falsa.
- **El bundle del admin.** `NEXT_PUBLIC_*` es una convención de nombre, no un
  candado: alcanza con que alguien bautice así a una variable para que termine
  en un `.js` público.

### Decisiones que lo hacen usable

**Sólo mira lo que git tiene versionado.** Recorrer el disco marcaba
`backend/.env` en cada corrida, que es exactamente el archivo donde los
secretos tienen que estar. Un hallazgo permanente en el lugar correcto entrena
a ignorar la herramienta.

Lo que sí se verifica aparte: que **ningún `.env` esté versionado**. No importa
qué tenga hoy — un `.env` en git es un `.env` que mañana va a tener un secreto.

**Busca formatos, no palabras.** `APP_USR-\d{6,}-…`, no «password». Buscar
palabras da un hallazgo por cada comentario que menciona una contraseña.

**Las cadenas de conexión a localhost no cuentan.** La primera versión produjo
veinte hallazgos, todos la misma línea de configuración de tests. Eso no es un
secreto: es la base de Docker que cualquiera levanta con el README.

**`// escaner:ok <motivo>`** silencia un hallazgo puntual. Hay lugares donde la
forma de un secreto es lo que se está probando: el test que verifica que los
logs tachan un token de Mercado Pago necesita un token con forma de token. El
marcador va en el código y se ve en el diff, a diferencia de una lista de
exclusiones que crece y nadie revisa.

### El control positivo

Un escáner que dice «sin hallazgos» no prueba nada hasta que se lo ve encontrar
algo:

```bash
# escaner:ok — el AKIA de abajo es el ejemplo público de AWS y es el señuelo de
# este mismo procedimiento. Sin el marcador, el escáner se denuncia a sí mismo
# en cada corrida — cosa que pasó al escribir esta página.
SENUELO=https://AKIAIOSFODNN7EXAMPLE.vendox.com.ar

flutter build apk --release --target-platform android-arm64 --dart-define=API_BASE_URL=$SENUELO
node tools/escanear-secretos.mjs --apk .../app-release.apk
```

Reporta «Clave de acceso de AWS» dentro de `libapp.so`. Verificado.

⚠️ La constante inyectada tiene que ser una que la app **use**. Con
`SPIKE_API_KEY` no encuentra nada, y no porque falle.

---

## Resultado del escaneo

Del 15 de agosto de 2026, sobre `app-arm64-v8a-release.apk` (33,9 MB), el
bundle del admin y todo lo versionado.

| Objetivo | Entradas | Hallazgos |
|---|---|---|
| Repositorio | todo lo que `git ls-files` devuelve | 0 |
| APK de release | 105 entradas | 0 |
| Bundle del admin | 28 archivos del cliente | 0 |

Versionados hay tres archivos `.env`, los tres `.example`, con `USER:PASS` y
huecos para completar.

---

## Lo que falta

- **La APK de release está firmada con la clave de debug.** Sirve para instalar
  en teléfonos propios y nada más. Publicar exige generar una clave propia — y
  si se pierde, no se puede volver a publicar una actualización nunca: hay que
  subir una app nueva. Al cambiarla también cambia la huella SHA-1, así que hay
  que agregar un cliente de OAuth de Android nuevo en Google Cloud.
- **R8 está apagado** (`minifyEnabled` sin definir). Encenderlo achica la APK y
  ofusca los nombres, pero puede romper plugins en tiempo de ejecución de una
  forma que no se ve compilando. No se toca sin poder probar en un teléfono.
- **El escáner no corre solo.** Está para invocarlo; no hay hook ni CI que lo
  dispare.
