// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.js', '**/*.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['error'] }],

      // ── Reglas propias del proyecto ──────────────────────────────────────
      'no-restricted-syntax': [
        'error',
        {
          // Concatenar SQL es inyección esperando ocurrir. Las plantillas
          // etiquetadas de Prisma ($queryRaw`…`) sí parametrizan.
          selector: "MemberExpression[property.name=/^(\\$queryRawUnsafe|\\$executeRawUnsafe)$/]",
          message:
            'Prohibido: usá $queryRaw`…` / $executeRaw`…` con plantillas etiquetadas, que parametrizan.',
        },
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Prohibido: importá `env` desde @/config/env.schema, que está validado.',
        },
      ],
    },
  },
  {
    // La configuración es el único lugar que puede leer process.env.
    files: ['src/config/env.schema.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-console': 'off' },
  },
  {
    // Los tests hacen aserciones sobre JSON recién parseado, que es `any` por
    // definición. Exigir tipado completo ahí agrega ruido sin atrapar ningún
    // bug: si la forma de la respuesta cambia, el test falla igual.
    //
    // La regla sigue activa en `src/`, que es donde el `any` sí hace daño.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
