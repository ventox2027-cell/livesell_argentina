import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

/**
 * ESLint del panel.
 *
 * `eslint-config-next` 16 exporta configuraciones planas directamente, así que
 * no hace falta FlatCompat ni el `.eslintrc` viejo.
 */
const config = [
  ...coreWebVitals,
  ...typescript,
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
];

export default config;
