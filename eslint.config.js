import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', '.vscode/', 'build/'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        chrome: 'readonly',
        node: true,
      },
    },
    rules: {
      'no-console': 'off',
      'no-debugger': 'error',
      'prefer-const': 'warn',
    },
  }
);
