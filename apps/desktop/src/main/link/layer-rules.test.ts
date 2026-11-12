import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { LAYER_RULES } from '../../../../../eslint.config.mjs';

/*
 * Which part of the code may import which (docs/ARCHITECTURE.md 第 2 节, AGENTS.md 第 4 节第 2 条). The rules are
 * ESLint's (eslint.config.mjs `LAYER_RULES`); this runs those same blocks, and nothing else of the lint, over the
 * sources, so they hold where lint is not run, and proves with one import per rule that each of them still reports.
 * The second part is the reason this file exists: the window's layer rules were in the lint config for weeks without
 * ever reporting (imports without a file extension were not resolved), and nobody could tell.
 */

const REPOSITORY = fileURLToPath(new URL('../../../../../', import.meta.url));

const eslint = new ESLint({ cwd: REPOSITORY, overrideConfigFile: true, overrideConfig: [
  { files: ['**/*.{ts,tsx}'], languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: 'off' } },
  ...LAYER_RULES
] });

/** What the layer rules say about `source`, as if it were the file at `path` (which need not exist). */
async function reported(path: string, source: string): Promise<string[]> {
  const results = await eslint.lintText(source, { filePath: `${REPOSITORY}${path}` });
  return results.flatMap(result => result.messages.map(message => message.ruleId ?? message.message));
}

const WINDOW = 'apps/desktop/src/renderer/src';

describe('分层：哪一部分能引用哪一部分', () => {
  it('源码里没有越界的引用', async () => {
    const results = await eslint.lintFiles(['packages/schema/src', 'packages/core/src', 'apps/desktop/src']);
    const problems = results.flatMap(result => result.messages.map(message => `${result.filePath.slice(REPOSITORY.length)}:${message.line} ${message.message}`));
    expect(problems).toEqual([]);
    // The three roots were really read.
    expect(results.length).toBeGreaterThan(900);
  }, 180_000);

  it('packages/schema 只用 zod', async () => {
    expect(await reported('packages/schema/src/probe.ts', "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n")).toEqual(['no-restricted-imports']);
    expect(await reported('packages/schema/src/probe.ts', "import type { LinkCommand } from '@tb/core';\nexport type A = LinkCommand;\n")).toEqual(['no-restricted-imports']);
    expect(await reported('packages/schema/src/probe.ts', "import { z } from 'zod';\nimport { a } from './link-project';\nexport const b = [z, a];\n")).toEqual([]);
  });

  it('packages/core 不碰 Node、Electron 和 React', async () => {
    for (const module of ['node:fs', 'node:path', 'electron', 'react', 'zustand', '../../../apps/desktop/src/main/link/run-logger']) {
      const expected = module.startsWith('.') ? [] : ['no-restricted-imports'];
      expect(await reported('packages/core/src/probe.ts', `import * as taken from '${module}';\nexport const used = taken;\n`), module).toEqual(expected);
    }
    expect(await reported('packages/core/src/probe.ts', "import type { LinkProject } from '@tb/schema';\nimport { z } from 'zod';\nimport { a } from './show-state';\nexport const b: [LinkProject | null, unknown, unknown] = [null, z, a];\n")).toEqual([]);
    // A test may read files to scan the sources.
    expect(await reported('packages/core/src/probe.test.ts', "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n")).toEqual([]);
  });

  it('主进程不引用界面和预加载的文件', async () => {
    expect(await reported('apps/desktop/src/main/link/probe.ts', "import { useDocumentStore } from '../../renderer/src/link/stores/document-store';\nexport const store = useDocumentStore;\n")).toEqual(['no-restricted-imports']);
    expect(await reported('apps/desktop/src/main/link/probe.ts', "import { bridge } from '../../preload/index';\nexport const used = bridge;\n")).toEqual(['no-restricted-imports']);
    expect(await reported('apps/desktop/src/main/link/probe.ts', "import { readFile } from 'node:fs/promises';\nimport { showGate } from '@tb/core/link';\nexport const used = [readFile, showGate];\n")).toEqual([]);
  });

  it('界面不引用 Electron、Node 和主进程的文件', async () => {
    for (const module of ['electron', 'node:fs', '../../../../main/link/run-logger', '../../../../preload/index']) {
      expect(await reported(`${WINDOW}/link/runtime/probe.ts`, `import * as taken from '${module}';\nexport const used = taken;\n`), module).toEqual(['no-restricted-imports']);
    }
    expect(await reported(`${WINDOW}/link/runtime/probe.ts`, "import { showGate } from '@tb/core/link';\nimport { create } from 'zustand';\nexport const used = [showGate, create];\n")).toEqual([]);
  });

  it('预加载只是桥', async () => {
    expect(await reported('apps/desktop/src/preload/probe.ts', "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n")).toEqual(['no-restricted-imports']);
    expect(await reported('apps/desktop/src/preload/probe.ts', "import { ipcRenderer } from 'electron';\nimport type { LinkProject } from '@tb/schema';\nexport const used: [unknown, LinkProject | null] = [ipcRenderer, null];\n")).toEqual([]);
  });

  it('界面里：组件下面的各层不引用组件，公共控件不读仓库，适配器不知道上面的层', async () => {
    const component = "import { ProjectPlayerTransport } from '../components/ProjectPlayerControls';\nexport const used = ProjectPlayerTransport;\n";
    for (const layer of ['stores', 'runtime', 'view-models', 'keys', 'ui']) {
      expect(await reported(`${WINDOW}/link/${layer}/probe.ts`, component), layer).toEqual(['boundaries/dependencies']);
    }
    const store = "import { useDocumentStore } from '../stores/document-store';\nexport const used = useDocumentStore;\n";
    expect(await reported(`${WINDOW}/link/ui/probe.tsx`, store)).toEqual(['boundaries/dependencies']);
    expect(await reported(`${WINDOW}/link/components/probe.tsx`, store)).toEqual([]);
    expect(await reported(`${WINDOW}/link/runtime/probe.ts`, store)).toEqual([]);
    expect(await reported(`${WINDOW}/registry/probe.ts`, "import { useDocumentStore } from '../link/stores/document-store';\nexport const used = useDocumentStore;\n")).toEqual(['boundaries/dependencies']);
    // Tests reach across to build what they test.
    expect(await reported(`${WINDOW}/link/stores/probe.test.ts`, component)).toEqual([]);
  });

  it('正式的 lint 配置用的就是这些规则', async () => {
    const lint = new ESLint({ cwd: REPOSITORY });
    const rules = async (path: string): Promise<Record<string, unknown>> => ((await lint.calculateConfigForFile(`${REPOSITORY}${path}`)) as { rules?: Record<string, unknown> }).rules ?? {};
    for (const path of ['packages/schema/src/link-project.ts', 'packages/core/src/show-state.ts', 'apps/desktop/src/main/link/run-logger.ts',
      'apps/desktop/src/preload/index.ts', `${WINDOW}/link/stores/document-store.ts`]) {
      expect(JSON.stringify((await rules(path))['no-restricted-imports']), path).toContain('"regex"');
    }
    expect(JSON.stringify((await rules(`${WINDOW}/link/stores/document-store.ts`))['boundaries/dependencies'])).toContain('"components"');
  }, 60_000);
});
