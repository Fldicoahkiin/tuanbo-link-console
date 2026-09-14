import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.{ts,tsx}']
}));

export default tseslint.config(
  {
    ignores: [
      '交付*/**',
      'acceptance-*/**',
      'artifacts/**',
      'tools/obs/native-preview/compiler/**',
      'tools/obs/native-preview/portable/**',
      '%SystemDrive%/**',
      '**/.agents/**',
      '**/dist/**',
      '**/dist-*/**',
      'output/**',
      '**/out/**',
      'apps/desktop/out-*/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/electron.vite.config.*.mjs'
    ]
  },
  {
    ...js.configs.recommended,
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: {
        ...globals.node
      }
    }
  },
  ...typeCheckedConfigs,
  {
    files: ['scripts/check-timeline-auto-lanes.mjs'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './packages/*/tsconfig.json', './apps/desktop/tsconfig.node.json', './apps/desktop/tsconfig.web.json', './apps/desktop/tsconfig.e2e.json'],
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-confusing-void-expression': 'off'
    }
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off'
    }
  },
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    files: ['apps/desktop/src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 160, skipBlankLines: true, skipComments: true, IIFEs: true }]
    }
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off'
    }
  },
  {
    files: ['apps/desktop/src/renderer/src/**/*.{ts,tsx}'],
    plugins: {
      boundaries
    },
    settings: {
      'boundaries/elements': [
        { type: 'registry', pattern: 'apps/desktop/src/renderer/src/registry/**' },
        { type: 'stores', pattern: 'apps/desktop/src/renderer/src/link/stores/**' },
        { type: 'runtime', pattern: 'apps/desktop/src/renderer/src/link/runtime/**' },
        { type: 'view-models', pattern: 'apps/desktop/src/renderer/src/link/view-models/**' },
        { type: 'components', pattern: 'apps/desktop/src/renderer/src/link/components/**' }
      ]
    },
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'allow',
        rules: [
          { from: { type: 'registry' }, disallow: { to: { type: ['stores', 'runtime', 'view-models', 'components'] } } },
          { from: { type: 'stores' }, disallow: { to: { type: ['runtime', 'view-models', 'components'] } } },
          { from: { type: 'components' }, disallow: { to: { type: 'registry' } } }
        ]
      }]
    }
  }
);
