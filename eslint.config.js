import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'archive/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
  },

  // ---------------------------------------------------------------------
  // The core/shell boundary (DESIGN.md §15).
  //
  // src/core is a library. It does not know how it is being driven — that's
  // what makes Electron (M5) a second shell rather than a port. Enforced
  // here rather than trusted, same posture as the `usejournal` ban (§3).
  //
  // Need to report something? Take a ProgressReporter and emit an event.
  // Need a setting? Take it in the config object.
  // ---------------------------------------------------------------------
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            'core must not touch process — take config as an argument and report via ProgressReporter (DESIGN.md §15).',
        },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'exit',
          message: 'core must not exit — throw, and let the shell decide (DESIGN.md §15).',
        },
      ],
    },
  },

  // Tests may do whatever they need.
  {
    files: ['**/*.test.ts'],
    rules: { 'no-console': 'off', 'no-restricted-globals': 'off' },
  },
);
