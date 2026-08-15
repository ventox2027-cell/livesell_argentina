/**
 * Replay de un vivo.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ESTO NO ESTÁ ACTIVADO, Y NO SE ACTIVA HASTA QUE SE DECIDAN TRES COSAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * El archivo existe para que el modelo de datos y los contratos estén pensados
 * antes de escribir la primera línea que grabe algo. Grabar es fácil; deshacer
 * una decisión de almacenamiento sobre miles de horas de video no lo es.
 *
 * Las tres decisiones pendientes, en orden de cuánto duelen si se eligen mal:
 *
 *   1. **Cuánto se guarda.** Una hora de 720p son ~500 MB. Cien vendedores
 *      transmitiendo dos horas por semana son 400 GB al mes, que se acumulan.
 *      Sin una política de retención decidida ANTES, el costo crece hasta que
 *      alguien lo mira y ya hay veinte terabytes que nadie quiere borrar.
 *
 *   2. **Quién puede verlo.** Un vivo es efímero por naturaleza: la gente dice
 *      cosas frente a la cámara sabiendo que se van. Un replay público cambia
 *      eso sin avisar, y el chat grabado convierte un comentario de un momento
 *      en algo permanente y buscable.
 *
 *   3. **Qué pasa con lo que se muestra.** Un producto que salía $18.000 en el
 *      vivo puede salir $25.000 cuando alguien mira el replay tres semanas
 *      después. Mostrar la grabación con el botón de comprar al lado es
 *      publicidad de un precio que ya no existe.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POR QUÉ ESTÁ ESCRITO Y NO SIMPLEMENTE PENDIENTE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Porque LiveKit puede empezar a grabar en cualquier momento con un cambio de
 * configuración, y el día que alguien lo prenda «para probar» va a necesitar
 * un lugar donde guardar la referencia. Si ese lugar no existe, se improvisa —
 * y las improvisaciones de almacenamiento son las que después nadie migra.
 *
 * Con los tipos escritos, prender la grabación es implementar una interfaz. Sin
 * ellos, es inventar un esquema a las apuradas.
 *
 * ⚠️ **No hay ningún servicio que implemente esto.** Es deliberado: un
 * `ReplayService` con métodos que devuelven `null` invita a que alguien
 * construya una pantalla encima y descubra en producción que no hay nada
 * detrás. Ver `identity.provider.ts` para la misma regla aplicada a los
 * proveedores de verificación.
 */

/** En qué estado está la grabación de un vivo. */
export type EstadoDeGrabacion =
  /** El vivo terminó y nunca se grabó. Es el estado de todos hoy. */
  | 'NO_GRABADO'
  /** LiveKit está grabando ahora mismo. */
  | 'GRABANDO'
  /** Terminó de grabar y el archivo se está procesando. */
  | 'PROCESANDO'
  /** Hay un archivo reproducible. */
  | 'DISPONIBLE'
  /** Se venció la retención y el archivo se borró. Ver punto 1 de arriba. */
  | 'VENCIDO'
  /** Algo falló. El vivo pasó igual: un replay perdido no es una caída. */
  | 'FALLIDO';

/**
 * Quién puede ver el replay.
 *
 * ⚠️ El valor por defecto tiene que ser el más cerrado que exista. Un replay
 * que nace público convierte una decisión que el vendedor nunca tomó en algo
 * que ya pasó — y en internet, «ya pasó» no se deshace.
 */
export type VisibilidadDelReplay =
  /** Sólo el vendedor. **El que va por defecto.** */
  | 'PRIVADO'
  /** Cualquiera con el enlace. No aparece en el feed ni en buscadores. */
  | 'CON_ENLACE'
  /** En el perfil de la tienda, para cualquiera. */
  | 'PUBLICO';

export const VISIBILIDAD_POR_DEFECTO: VisibilidadDelReplay = 'PRIVADO';

/**
 * El registro de una grabación.
 *
 * ─── Por qué la URL no está acá ───
 *
 * Un replay se sirve con una URL **firmada y de vida corta**, generada en el
 * momento de pedirlo. Guardar una URL permanente en la base la convierte en
 * una credencial que se filtra en cada respuesta de la API, en cada log y en
 * cada captura de pantalla de alguien depurando.
 *
 * Lo que se guarda es la clave del objeto en el almacenamiento; la URL se firma
 * al servir. Es la misma disciplina que ya usan las fotos de producto.
 */
export interface Grabacion {
  readonly liveSessionId: string;
  readonly estado: EstadoDeGrabacion;
  readonly visibilidad: VisibilidadDelReplay;

  /** Clave del objeto en el almacenamiento. Nunca una URL. */
  readonly claveDelArchivo: string | null;

  readonly duracionSegundos: number | null;
  readonly tamanoBytes: number | null;

  /** Cuándo se borra. `null` mientras no haya política de retención. */
  readonly venceEl: Date | null;
}

/**
 * Lo que hay que resolver antes de servir un replay con productos al lado.
 *
 * No es una función que exista: es la firma de la decisión pendiente, escrita
 * para que quien la implemente no se olvide del problema.
 *
 * Las opciones que ya se descartaron, y por qué:
 *
 *   · **Mostrar el precio del vivo** — es publicidad de un precio vencido, y
 *     la ley de defensa del consumidor lo trata como tal.
 *   · **Ocultar los productos** — deja un video sin contexto comercial, que es
 *     la mitad de para qué existiría el replay.
 *
 * La que queda en pie es mostrar el precio ACTUAL con una marca de que el vivo
 * ya terminó. Falta decidir cómo se ve.
 */
export interface ProductoEnReplay {
  readonly productId: string;
  /** El precio de HOY, no el del vivo. */
  readonly precioActualCentavos: number;
  /** Si sigue disponible. Un replay puede sobrevivir al producto. */
  readonly vendible: boolean;
}

/**
 * El contrato que va a tener que cumplir quien implemente esto.
 *
 * Está declarado como `interface` y no como clase abstracta a propósito: no
 * hay nada que inyectar todavía, y una clase abstracta en el contenedor de
 * dependencias es algo que alguien puede resolver con una implementación falsa
 * sin que se note.
 */
export interface ProveedorDeReplay {
  /** Arranca la grabación. Devuelve el id que asigna el proveedor. */
  empezar(liveSessionId: string): Promise<string>;

  /** La corta. Idempotente: cortar una que ya terminó no es un error. */
  terminar(liveSessionId: string): Promise<void>;

  /** Una URL firmada y de vida corta. Nunca una permanente. */
  urlFirmada(claveDelArchivo: string, segundosDeVida: number): Promise<string>;

  /** Borra el archivo. Lo llama el barrido de retención, cuando exista. */
  borrar(claveDelArchivo: string): Promise<void>;
}
