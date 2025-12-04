import obsidian from 'eslint-plugin-obsidianmd';
import tseslint from 'typescript-eslint';

export default [
  // TypeScript recommended config
  ...tseslint.configs.recommended,

  // Configure obsidianmd plugin rules manually
  {
    files: ['**/*.ts'],
    plugins: {
      obsidianmd: obsidian,
    },
    rules: {
      // Obsidian plugin rules
      'obsidianmd/settings-tab/no-manual-html-headings': 'error',
      'obsidianmd/ui/sentence-case': ['error', { enforceCamelCaseLower: true }],
      'obsidianmd/no-sample-code': 'error',
      'obsidianmd/validate-manifest': 'error',

      // TypeScript rules
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'no-prototype-builtins': 'off',
      '@typescript-eslint/no-this-alias': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
