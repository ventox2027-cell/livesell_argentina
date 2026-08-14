/**
 * Dónde corre el contenedor.
 *
 * Vive en su propio archivo, sin importar nada, porque lo necesitan los dos
 * lados de una relación que si no sería circular: el esquema de configuración
 * lo usa para validar `DEPLOYMENT_PROVIDER`, y el resolver de IP —que lee la
 * configuración— lo usa para elegir estrategia.
 *
 * La lista es CERRADA. Agregar un proveedor es agregar código en
 * `client-ip.ts` que documente qué hace su borde con las cabeceras, no sumar
 * una cadena acá. Ver ahí por qué esa disciplina importa.
 */
export const PROVEEDORES = ['local', 'fly', 'render', 'ibm_code_engine'] as const;

export type DeploymentProvider = (typeof PROVEEDORES)[number];
