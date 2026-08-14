import { Injectable, Logger } from '@nestjs/common';

/**
 * Verificación de identidad y situación fiscal.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HAY INTEGRACIÓN CON RENAPER NI CON ARCA, Y NO SE FINGE QUE LA HAY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No tenemos contrato ni credenciales con ninguno de los dos. Esto importa
 * decirlo en el código y no sólo en un documento: un adaptador que se llama
 * `RenaperProvider` y devuelve `verificado: true` sin llamar a nadie es una
 * mentira que en tres meses alguien va a creer, y vamos a tener vendedores
 * "verificados por RENAPER" que nunca pasaron por ahí.
 *
 * Lo que hay es la interfaz y **un proveedor manual que dice la verdad**: la
 * revisión la hace una persona del equipo, y el resultado se guarda como
 * `provider = "manual"`.
 *
 * ─── Qué se gana definiendo la interfaz ahora ───
 *
 * Que el dominio no quede acoplado a ningún proveedor. `SellerVerification`
 * guarda "quién verificó, cuándo y qué respondió", que es la forma correcta
 * independientemente de si del otro lado hay una API del Estado o una persona
 * mirando. El día que exista el contrato, se escribe un adaptador y no cambia
 * nada más.
 *
 * ⚠️ **El número de documento no se guarda.** Llega, se usa para consultar, y
 * se descarta. Ver el comentario del modelo en el esquema.
 */

export interface DatosDeIdentidad {
  nombre: string;
  apellido: string;
  tipoDocumento: string;
  /** ⚠️ Sólo existe durante esta llamada. No se persiste. */
  numeroDocumento: string;
}

export interface ResultadoDeVerificacion {
  /** `manual`, y en el futuro `renaper`, `didit`, lo que sea. */
  proveedor: string;
  /**
   * `null` significa "todavía no se sabe" y NO "no verificado".
   *
   * La distinción importa: una verificación pendiente de revisión humana no es
   * un rechazo, y tratarla como tal dejaría afuera a todo el mundo mientras la
   * cola se procesa.
   */
  verificado: boolean | null;
  /** Qué respondió, en texto. Se guarda para poder auditar la decisión. */
  detalle: string;
}

export abstract class IdentityVerificationProvider {
  abstract verificar(datos: DatosDeIdentidad): Promise<ResultadoDeVerificacion>;
}

export interface DatosFiscales {
  /** ⚠️ Sólo existe durante esta llamada. No se persiste. */
  cuit: string;
  nombre: string;
  apellido: string;
}

export abstract class TaxVerificationProvider {
  abstract verificar(datos: DatosFiscales): Promise<ResultadoDeVerificacion>;
}

/**
 * El proveedor de hoy: una persona del equipo.
 *
 * Deja la verificación en estado indeterminado para que la resuelva un admin
 * desde el panel. No inventa un resultado ni lo aprueba solo.
 *
 * ─── Lo poco que sí comprueba ───
 *
 * La forma del documento. No verifica que exista ni que sea de esa persona
 * —para eso hace falta el organismo— pero descarta lo que directamente no puede
 * ser un DNI o un CUIT, que ahorra revisiones manuales de datos mal tipeados.
 */
@Injectable()
export class ManualIdentityProvider extends IdentityVerificationProvider {
  private readonly logger = new Logger(ManualIdentityProvider.name);

  verificar(datos: DatosDeIdentidad): Promise<ResultadoDeVerificacion> {
    const soloDigitos = datos.numeroDocumento.replace(/\D/g, '');

    // Un DNI argentino tiene 7 u 8 dígitos.
    if (soloDigitos.length < 7 || soloDigitos.length > 8) {
      return Promise.resolve({
        proveedor: 'manual',
        verificado: false,
        detalle: 'El número de documento no tiene una forma válida (7 u 8 dígitos).',
      });
    }

    // Nunca se registra el número. Sólo que llegó algo con forma correcta.
    this.logger.log({ msg: 'identidad enviada a revisión manual', tipo: datos.tipoDocumento });

    return Promise.resolve({
      proveedor: 'manual',
      verificado: null,
      detalle: 'Pendiente de revisión por una persona del equipo.',
    });
  }
}

@Injectable()
export class ManualTaxProvider extends TaxVerificationProvider {
  verificar(datos: DatosFiscales): Promise<ResultadoDeVerificacion> {
    const cuit = datos.cuit.replace(/\D/g, '');

    if (cuit.length !== 11) {
      return Promise.resolve({
        proveedor: 'manual',
        verificado: false,
        detalle: 'El CUIT/CUIL debe tener 11 dígitos.',
      });
    }

    if (!digitoVerificadorValido(cuit)) {
      return Promise.resolve({
        proveedor: 'manual',
        verificado: false,
        detalle: 'El CUIT/CUIL no pasa la validación de su dígito verificador.',
      });
    }

    return Promise.resolve({
      proveedor: 'manual',
      verificado: null,
      detalle: 'Forma válida. Pendiente de revisión.',
    });
  }
}

/**
 * Dígito verificador del CUIT (módulo 11).
 *
 * ─── Por qué vale la pena ───
 *
 * Es aritmética local, sin red, y descarta el error más común: un dígito mal
 * tipeado. Un CUIT con la forma correcta pero el verificador mal **no existe**,
 * así que rechazarlo en el momento le ahorra a la persona esperar una revisión
 * manual para que le digan que se equivocó tipeando.
 *
 * No prueba que el CUIT sea de quien dice ser. Eso sólo lo puede decir ARCA.
 */
function digitoVerificadorValido(cuit: string): boolean {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const digitos = cuit.split('').map(Number);

  const suma = pesos.reduce((acc, peso, i) => acc + peso * (digitos[i] ?? 0), 0);
  const resto = suma % 11;
  const esperado = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;

  return esperado === digitos[10];
}
