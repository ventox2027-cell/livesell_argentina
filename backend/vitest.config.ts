import { resolve } from 'node:path';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest usa esbuild, que NO emite metadata de decoradores. Sin swc, la
  // inyección de dependencias de NestJS falla en los tests con errores
  // opacos del tipo "Nest can't resolve dependencies".
  plugins: [swc.vite({ module: { type: 'es6' } })],

  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },

  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Deja el entorno válido ANTES de importar nada: env.schema.ts valida al
    // cargarse y mata el proceso si falta una variable.
    setupFiles: ['test/setup.ts'],

    // Los tests de integración comparten una base PostgreSQL real. En paralelo
    // se pisan entre sí, y un test que falla según el orden es peor que uno
    // que falla siempre.
    fileParallelism: false,

    testTimeout: 30_000,
    hookTimeout: 30_000,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.module.ts', 'src/**/dto/**'],
    },
  },
});
