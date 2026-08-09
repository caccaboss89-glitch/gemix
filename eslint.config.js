import globals from 'globals';

export default [
  {
    ignores: [
      '.grok/',
      '.claude/',
      'graphify-out/',
      'node_modules/',
      '.wwebjs_auth/',
      '.wwebjs_cache/',
      '.wwebjs_cache',
      '__pycache__/',
      '**/__pycache__/',
      'bin/',
      'src/logs/',
      'src/data/',
      '.tempfiles/'
    ]
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