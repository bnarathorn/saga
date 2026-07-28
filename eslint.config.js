import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'docs/openapi.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause[param=undefined] > BlockStatement[body.length=0]',
          message: 'Empty catch blocks silently swallow failures.',
        },
      ],
    },
  },
  {
    // Test code and local tooling may use `any` where a precise type would add noise
    // without adding safety.
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'scripts/**',
      'db/**',
      'testing/**',
      'apps/web/e2e/**',
      'apps/web/src/test-utils.tsx',
      'apps/server/src/testing/**',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Guild Hall ships to a browser. A *value* import from the `@saga/contracts` barrel drags
    // the whole Zod runtime and every server-side schema into the bundle (measured: ~20 KB
    // gzip, a quarter of it). Types are erased at compile time, so those stay free; runtime
    // constants belong in the Zod-free `@saga/contracts/constants`.
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    // Test code is not in the browser bundle: Vite's entry is `main.tsx`, and nothing the
    // app renders imports a test file.
    ignores: [
      'apps/web/src/**/*.test.ts',
      'apps/web/src/**/*.test.tsx',
      'apps/web/src/test-utils.tsx',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@saga/contracts',
              message:
                'Import types from @saga/contracts, runtime values from @saga/contracts/constants. A value import pulls Zod into the browser bundle.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // Plain Node scripts: no TypeScript project, but the Node globals are real.
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  prettier,
);
