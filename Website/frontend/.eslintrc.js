/** @type {import('eslint').Linter.Config} */
module.exports = {
  extends: ['next/core-web-vitals'],
  plugins: ['@typescript-eslint'],
  rules: {
    // TypeScript-specific rules
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    // React rules
    'react/no-unescaped-entities': 'off',
    // General
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    'no-debugger': 'warn',
  },
  ignorePatterns: ['.next/', 'node_modules/', '*.config.js'],
};