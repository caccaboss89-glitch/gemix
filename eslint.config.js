import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', '.git/', '.grok/', '.wwebjs_auth/', 'graphify-out/']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: {
        ...globals.node,
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly'
      }
    },
    rules: {
      'indent': ['error', 2],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      'no-unused-vars': ['warn'],
      'no-console': 'off',
      'eqeqeq': ['error', 'always'],
      'prefer-const': 'warn',
      'no-var': 'warn',
      'no-multiple-empty-lines': ['error', { max: 2 }],
      'comma-dangle': ['error', 'never'],
      'no-trailing-spaces': 'error'
    }
  }
];