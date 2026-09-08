// Плоский конфиг ESLint 9. Проверяет только собственный код: движок и chess.js исключены.
export default [
  {
    ignores: ['engine/**', 'lib/chess.js', 'lib/LICENSE-chess.js', 'node_modules/**', 'dist/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        Worker: 'readonly',
        requestAnimationFrame: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        postMessage: 'readonly',
        WebAssembly: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        MutationObserver: 'readonly',
        confirm: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
        Date: 'readonly',
        Promise: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-undef': 'error',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
    },
  },
  {
    // Node-скрипты: тесты и сборка.
    files: ['test/**/*.js', 'test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
];
