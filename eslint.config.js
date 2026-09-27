import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['node_modules/', 'dist/', 'openspec/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { files: ['src/**/*.ts', '*.js', 'scripts/*.mjs'], languageOptions: { globals: globals.node } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
)
