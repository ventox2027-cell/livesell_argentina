/// Cómo se llega al vivo desde la tienda.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// «VOLVER» Y «ABRIR» NO SON LO MISMO, Y SE PARECEN MUCHO
/// ═══════════════════════════════════════════════════════════════════════════
///
/// El botón «EN VIVO» de la tienda se ve igual en los dos casos, y hace cosas
/// distintas según de dónde se llegó:
///
///   **Desde el vivo** — el visor está ABAJO en la pila, todavía montado y
///   conectado. Se vuelve con `pop`. Abrirlo de nuevo con un `push` dejaría dos
///   visores del mismo vivo, con dos conexiones de LiveKit y dos chats.
///
///   **Desde un enlace** — `vendox.com.ar/t/<slug>` no pasó por ningún vivo. No
///   hay nada abajo que devolver, así que hay que abrirlo. Un `pop` acá cerraría
///   la tienda y dejaría a la persona donde estaba antes, que no es a donde
///   pidió ir.
///
/// Es una decisión de dos líneas que sale mal de una forma cara y silenciosa
/// —dos conexiones de video—, así que vive acá, aparte y probada.
enum ComoLlegarAlVivo {
  /// El visor ya está montado abajo: se vuelve a él.
  volverAtras,

  /// No hay ninguno: se abre.
  abrirElVisor,

  /// No hay vivo al aire. El botón ni se dibuja.
  nada,
}

/// Decide qué hacer al tocar «EN VIVO».
///
/// [liveDetras] es el vivo del que se vino, si se vino de uno. [liveDelVendedor]
/// es el que informó el backend al resolver la tienda.
///
/// ⚠️ `liveDetras` gana siempre. Si se vino de un vivo, ése es el que está
/// montado abajo — aunque el backend informe otro id, que puede pasar si el
/// vendedor terminó una transmisión y empezó otra mientras la tienda estaba
/// abierta. Volver al que está abajo es lo correcto: es el que la persona
/// estaba mirando.
ComoLlegarAlVivo comoLlegarAlVivo({String? liveDetras, String? liveDelVendedor}) {
  if (liveDetras != null) return ComoLlegarAlVivo.volverAtras;
  if (liveDelVendedor != null) return ComoLlegarAlVivo.abrirElVisor;
  return ComoLlegarAlVivo.nada;
}
