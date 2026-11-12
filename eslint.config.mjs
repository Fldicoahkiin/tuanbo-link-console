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

const TEST_FILES = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'];
const layerImports = (regex, message) => ({ 'no-restricted-imports': ['error', { patterns: [{ regex, message }] }] });

/**
 * Layers (docs/ARCHITECTURE.md 第 2 节; AGENTS.md 第 4 节第 2 条): which part of the code may import which.
 * - packages/schema: zod only. packages/core: schema and a few pure libraries, never Node, Electron or React, so the
 *   rules run the same in the main process, in the window and in a test.
 * - The main process and the window never import each other's files; what crosses goes through the preload bridge as
 *   data defined in packages/schema. The window imports neither Electron nor Node.
 * - Inside the window: nothing below the components imports a component (stores, runtime, view-models, keys, registry
 *   and ui stay usable and testable without the pages); ui is plain controls and reads no store or runtime; registry
 *   (the adapters) knows nothing above it.
 * Tests are left out: they may reach across to build what they test.
 * layer-rules.test.ts lints the sources with these same blocks (so they hold where lint is not run) and checks, with
 * an import that breaks each rule, that every block still reports: the window's rules were in this file since
 * 2026-10 without ever reporting, because imports written without a file extension were not resolved
 * (LAYER_SETTINGS `import/resolver`).
 */
export const LAYER_SETTINGS = {
  'import/resolver': { node: { extensions: ['.ts', '.tsx', '.d.ts'] } },
  'boundaries/elements': [
    { type: 'registry', pattern: 'apps/desktop/src/renderer/src/registry/**' },
    { type: 'stores', pattern: 'apps/desktop/src/renderer/src/link/stores/**' },
    { type: 'runtime', pattern: 'apps/desktop/src/renderer/src/link/runtime/**' },
    { type: 'view-models', pattern: 'apps/desktop/src/renderer/src/link/view-models/**' },
    { type: 'keys', pattern: 'apps/desktop/src/renderer/src/link/keys/**' },
    { type: 'ui', pattern: 'apps/desktop/src/renderer/src/link/ui/**' },
    { type: 'components', pattern: 'apps/desktop/src/renderer/src/link/components/**' }
  ]
};
export const LAYER_RULES = [
  {
    files: ['packages/schema/src/**/*.ts'],
    ignores: TEST_FILES,
    rules: layerImports('^(?!\\.{1,2}/|zod$)', 'packages/schema 只放数据格式的定义，只能用 zod（docs/ARCHITECTURE.md 第 2 节）。')
  },
  {
    files: ['packages/core/src/**/*.ts'],
    ignores: TEST_FILES,
    rules: layerImports('^(?!\\.{1,2}/|@tb/schema$|zod$|midi-file$|pinyin-pro$)',
      'packages/core 是不依赖 Node、Electron 和 React 的纯规则，主进程、界面和测试都要能用。碰文件、进程、设备的代码放 apps/desktop/src/main/link/（docs/ARCHITECTURE.md 第 2 节）。')
  },
  {
    files: ['apps/desktop/src/main/**/*.ts'],
    ignores: TEST_FILES,
    rules: layerImports('(^|/)(renderer|preload)/', '主进程不引用界面和预加载的文件；两边共用的放 packages/core 或 packages/schema（docs/ARCHITECTURE.md 第 2 节）。')
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: layerImports('^electron($|/)|^node:|(^|/)(main|preload)/',
      '界面不引用 Electron、Node 和主进程的文件，只经预加载的 tbLink / tbFile 调用主进程；两边共用的放 packages/core 或 packages/schema（docs/ARCHITECTURE.md 第 2 节）。')
  },
  {
    files: ['apps/desktop/src/preload/**/*.ts'],
    rules: layerImports('^(?!electron$|zod$|@tb/schema$|@tb/core/link$)', '预加载只是类型化的桥：只用 electron、zod 和 packages 里的类型，不放业务逻辑。')
  },
  {
    files: ['apps/desktop/src/renderer/src/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    plugins: { boundaries },
    settings: LAYER_SETTINGS,
    rules: {
      'boundaries/dependencies': ['error', {
        default: 'allow',
        rules: [
          { from: { type: 'registry' }, disallow: { to: { type: ['stores', 'runtime', 'view-models', 'keys', 'ui', 'components'] } } },
          { from: { type: ['stores', 'runtime', 'view-models', 'keys'] }, disallow: { to: { type: 'components' } } },
          { from: { type: 'ui' }, disallow: { to: { type: ['stores', 'runtime', 'registry', 'components'] } } }
        ]
      }]
    }
  }
];

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
  ...LAYER_RULES
);
