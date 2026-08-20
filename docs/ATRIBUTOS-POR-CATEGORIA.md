# Atributos y variantes según categoría — plan

**Estado: propuesta. No se tocó el esquema ni se migró nada.**

Fecha: 19 de agosto de 2026.

---

## 1. Lo primero: buena parte ya existe

Antes de proponer nada, se leyó lo que hay. El modelo actual **ya soporta**
variantes por combinación de atributos:

```
Product
 └─ ProductOption          name ("Color"), position     @@unique(productId, name)
     └─ ProductOptionValue value ("Negro")
ProductVariant             title ("Negro / M")
 └─ ProductVariantOption   (variantId, optionValueId)   ← la combinación
Inventory                  por VARIANTE                 ← el stock ya es por combinación
```

Y del lado del comprador, `variant_sheet.dart` ya:

- exige elegir una combinación antes de comprar,
- **deshabilita** los valores sin stock —`valorTieneStock(v.id, otrosElegidos)`,
  con el valor tachado y sin `onTap`—,
- limita la cantidad a lo disponible de esa variante.

Y el editor ya deja no crear variantes: con el interruptor apagado el backend
genera una variante `DEFAULT` que el vendedor nunca ve. **No se obliga a
inventar variantes ficticias.**

> Conclusión: los cuatro requisitos de estructura —stock por combinación,
> selección previa, combinaciones sin stock deshabilitadas, no forzar
> variantes— **ya están cumplidos**. No hace falta rediseñar el modelo de
> variantes.

---

## 2. Lo que falta de verdad

### a) No hay ninguna guía

El editor pregunta «¿Viene en varios talles o colores?» y después ofrece un
campo de texto libre para el nombre del eje y otro para los valores. El
vendedor de zapatillas tiene que **adivinar** que conviene poner «Talle» y
«Color», y en qué orden.

### b) Cada vendedor inventa su propio vocabulario

Como el nombre del eje y sus valores son texto libre:

| Vendedor | Eje | Valores |
|---|---|---|
| A | `Talle` | `S`, `M`, `L` |
| B | `talle` | `Small`, `Medium` |
| C | `Tamaño` | `1`, `2`, `3` |
| D | `TALLE` | `m`, `l` |

Hoy no rompe nada, porque nada filtra por atributo. **El día que exista «buscar
camperas talle M» no va a haber forma de hacerlo**, y para entonces habrá miles
de filas con el vocabulario ya dividido.

Ése es el costo real de no decidir esto ahora: no es la funcionalidad que falta,
es la que se vuelve imposible.

### c) `@@unique([productId, name])` es por texto

`Talle` y `talle` conviven en el mismo producto como dos ejes distintos.

---

## 3. La propuesta

**Un catálogo de atributos sugeridos por categoría, que guía sin obligar.**

### Modelo nuevo (aditivo, nada se borra)

```prisma
/// Un atributo que existe en el catálogo de VendoX. NO por producto.
///
/// "Talle" es UNO, aunque lo usen mil productos. Es lo que hace posible
/// filtrar por él algún día.
model Atributo {
  id        String  @id            // atr_talle_ropa
  nombre    String                 // "Talle"
  tipo      TipoDeAtributo         // LISTA | TEXTO | NUMERO
  unidad    String?                // "ml", "g", "cm" — null para LISTA
  valores   AtributoValor[]
  enCategorias CategoriaAtributo[]
  @@map("atributos")
}

model AtributoValor {
  id         String @id            // atv_talle_m
  atributoId String
  valor      String                // "M"
  position   Int    @default(0)    // el orden natural: S, M, L — no alfabético
  @@unique([atributoId, valor])
  @@map("atributo_valores")
}

/// Qué atributos sugiere cada categoría, y cuáles casi siempre hacen falta.
model CategoriaAtributo {
  categoryId String
  atributoId String
  /// Se propone marcado al crear el producto. NO se rechaza si no está.
  sugerido   Boolean @default(true)
  position   Int     @default(0)
  @@id([categoryId, atributoId])
  @@map("categoria_atributos")
}
```

Y **una sola columna nueva** en lo que ya existe:

```prisma
model ProductOption {
  // ...lo de hoy, sin tocar...

  /// A qué atributo del catálogo corresponde este eje. `null` = eje libre,
  /// que es lo que son todos los que ya existen.
  atributoId String? @map("atributo_id")
}

model ProductOptionValue {
  // ...lo de hoy, sin tocar...
  atributoValorId String? @map("atributo_valor_id")
}
```

### Por qué así y no de otra forma

- **No reemplaza el modelo actual, lo anota.** Un eje sin `atributoId` sigue
  funcionando exactamente como hoy. Cero riesgo para los productos existentes.
- **La lógica no vive en Flutter.** La app pide
  `GET /categories/:id/atributos` y dibuja lo que venga. Agregar «Material» a
  Hogar es una fila en la base, no una versión nueva de la app en Google Play.
- **Extensible sin migración**: una categoría nueva son filas.
- **El comprador gana filtros el día que se quieran**, porque los valores están
  normalizados donde importa.

### La semilla inicial

Con lo que pediste, sin inventar de más:

| Categoría | Atributos sugeridos |
|---|---|
| Indumentaria | Talle (lista), Color (lista) |
| Calzado | Talle de calzado (lista, numérica AR), Color |
| Cosmética | Tono (lista), Contenido (número + unidad) |
| Electrónica | Color, Capacidad (número + unidad) |
| Hogar | Color, Material (lista), Medida (texto) |
| Alimentos | Sabor (lista), Peso (número + unidad) |

⚠️ Estas listas son una decisión de producto, no técnica. Las escribí como
punto de partida para que las corrijas, no como algo cerrado.

---

## 4. Cómo cambia el editor

Hoy: interruptor → escribir el nombre del eje → escribir los valores.

Propuesto, **sólo cuando la categoría tiene atributos sugeridos**:

1. Al elegir el rubro, aparecen los ejes sugeridos como chips apagados.
2. Tocar «Talle» abre los valores del catálogo para tildar los que tiene.
3. «Otro atributo» sigue existiendo y sigue siendo texto libre.

Lo que **no** cambia:

- Si el producto tiene una sola configuración, no se crea ninguna variante. El
  interruptor de variantes sigue apagado por defecto.
- Nada obliga a usar los sugeridos.

---

## 5. Plan de migración

**No hay migración destructiva. No se borra ni se reescribe ninguna fila.**

| Paso | Qué hace | Reversible |
|---|---|---|
| 1 | `CREATE TABLE` de las tres tablas nuevas | sí, `DROP` |
| 2 | `ADD COLUMN atributo_id NULL` en `product_options` y `product_option_values` | sí, `DROP COLUMN` |
| 3 | Semilla de atributos y su relación con las categorías | sí, `DELETE` de la semilla |
| 4 | API: `GET /categories/:id/atributos` | sí, no lo usa nadie hasta el paso 5 |
| 5 | Editor: los chips | sí, es la app |

Los productos existentes quedan con `atributo_id = NULL` **para siempre**, y
funcionan igual. Si algún día se quiere vincularlos, se hace con una
correspondencia revisada a mano y **eso se te consulta antes**.

### Lo que NO propongo hacer

- Renombrar los ejes existentes para que coincidan con el catálogo. Sería
  reescribir datos de vendedores reales sobre una coincidencia de texto, y
  «Tamaño» de un vendedor de macetas no es el «Talle» de uno de ropa.
- Borrar ejes libres.
- Obligar a que un producto de Indumentaria tenga Talle. Un cinturón único
  existe.

---

## 6. Esfuerzo y orden sugerido

| Bloque | Qué incluye |
|---|---|
| 1 | Esquema + semilla + `GET /categories/:id/atributos` + tests |
| 2 | Editor: chips de atributos sugeridos + tests de widget |
| 3 | Validación en el backend de que un valor tildado pertenece al atributo |
| 4 | (Más adelante, si se quiere) filtros del comprador por atributo |

Los bloques 1 a 3 son autocontenidos y se pueden parar en cualquiera sin dejar
nada a medias.

---

## 7. Lo que necesito de vos antes de escribir código

1. **Confirmar las listas de la sección 3.** Son decisión de producto.
2. **Talle de indumentaria: ¿S/M/L, o numérico argentino (38/40/42), o los
   dos?** Cambia si es un atributo o dos.
3. **¿Los valores los define VendoX o los puede agregar el vendedor?** Si el
   vendedor puede agregar, el catálogo se ensucia igual y hay que decidir si
   se moderan.
4. **Confirmar que el bloque 1 se puede aplicar** — son tres tablas nuevas y
   dos columnas nulas, sin tocar datos existentes, pero es una migración y
   quedamos en que las migraciones se avisan.
