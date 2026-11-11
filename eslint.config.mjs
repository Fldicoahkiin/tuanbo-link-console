import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const typeCheckedConfigs = tseslint.configs.recommendedTypeChecked.map((config) => ({
  ...config,
  files: ['**/*.{ts,tsx}']
}));

/**
 * Keys (04 设计 K9): the window has one key listener, the key router's in apps/desktop/src/renderer/src/link/keys/,
 * which decides who acts on every key (routeKey). A listener of its own on the window, the page or an element's
 * capture phase would act before or beside it: Space would play twice, Escape stop under an open dialog. Components
 * register commands (useKeyCommands), panels (useKeyOverlay), drags (useDragSession) and their own keys (ownKeys).
 * The only files allowed these listeners are under link/keys/; tests are left out, their fake windows need one.
 * key-routing-scan.test.ts runs these same selectors over the sources, and checks the files with an onKeyDown.
 */
export const KEY_LISTENER_RESTRICTIONS = [
  {
    selector: "CallExpression[callee.property.name='addEventListener'][arguments.0.value=/^key(down|up|press)$/]",
    message: '按键只由 link/keys/key-router.ts 在窗口上听一次。要处理键，用 useKeyCommands 登记命令、useKeyOverlay 登记面板、ownKeys 声明元素自己的键（docs/KEYBOARD_SHORTCUTS.md）。'
  },
  {
    selector: 'AssignmentExpression[left.property.name=/^onkey(down|up|press)$/]',
    message: '按键只由 link/keys/key-router.ts 在窗口上听一次，不要用 onkeydown 这类属性另挂监听。'
  },
  {
    selector: 'JSXAttribute[name.name=/^onKey(Down|Up)Capture$/]',
    message: '捕获阶段的按键由 link/keys/key-router.ts 统一处理；元素自己的键用 onKeyDown 加 ownKeys 声明。'
  }
];
export const KEY_LISTENER_FILES = ['apps/desktop/src/renderer/src/**/*.{ts,tsx}'];
export const KEY_LISTENER_EXCEPTIONS = ['apps/desktop/src/renderer/src/link/keys/**', '**/*.test.ts', '**/*.test.tsx'];

export default tseslint.config(
  {
    ignores: [
      // Claude Code session worktrees are full checkouts of other branches.
      '.claude/**',
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
        project: ['./tsconfig.json', './packages/*/tsconfig.json', './apps/licensing-server/tsconfig.json', './apps/desktop/tsconfig.node.json', './apps/desktop/tsconfig.web.json', './apps/desktop/tsconfig.e2e.json'],
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
    files: KEY_LISTENER_FILES,
    ignores: KEY_LISTENER_EXCEPTIONS,
    rules: {
      'no-restricted-syntax': ['error', ...KEY_LISTENER_RESTRICTIONS]
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
