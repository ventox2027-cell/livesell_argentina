import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Configuración de las pruebas de estrés.
 *
 * ─── Por qué un archivo aparte y no un script con `tsx` ───
 *
 * Igual que los tests: esbuild —lo que usa `tsx`— NO emite metadata de
 * decoradores, y sin eso la inyección de dependencias de NestJS entrega
 * `undefined` en cada parámetro del constructor. El síntoma es un 500 con
 * "Cannot read properties of undefined" desde adentro de un guard, que no dice
 * nada sobre la causa real.
 *
 * El proyecto ya tropezó con esto en los tests y lo resolvió con swc. Acá se
 * hace lo mismo en vez de volver a descubrirlo.
 *
 * ─── Por qué no entra en la suite normal ───
 *
 * Mil peticiones tardan, y la suite tiene que poder correr en cada cambio sin
 * que dé pereza. Se ejecuta con `pnpm stress:inventory` cuando se toca el
 * camino de reserva, y antes de cada despliegue.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],

  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },

  test: {
    globals: false,
    environment: 'node',
    // `.stress.ts`, no `.spec.ts`: así la suite normal no lo levanta nunca.
    include: ['test/stress/**/*.stress.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    // Mil peticiones más la preparación de mil usuarios no entran en 30 s.
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
