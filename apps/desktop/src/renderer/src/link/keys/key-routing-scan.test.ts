import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, it } from 'vitest';
import { KEY_LISTENER_RESTRICTIONS } from '../../../../../../../eslint.config.mjs';

/*
 * The window's key router takes every key first, in the capture phase (key-router.ts, 04 设计 K3). Two guards keep it
 * the only one (K9), each for its own part:
 * - ESLint (eslint.config.mjs `KEY_LISTENER_RESTRICTIONS`, `no-restricted-syntax`) refuses, line by line, a key
 *   listener outside link/keys/: `addEventListener('keydown' | 'keyup' | 'keypress')`, `onkeydown =`,
 *   `onKeyDownCapture`, `onKeyUpCapture`. The last test here runs those same selectors over the sources, so they hold
 *   even where lint is not run, and checks that the lint config applies them.
 * - This scan checks what lint cannot see in one line: a file whose elements act on keys themselves (`onKeyDown=`,
 *   `onKeyUp=`) says which keys are theirs (`ownKeys`, key-owner.ts), or the window's keys act before them: Space
 *   plays, Escape stops, ↑↓ change songs while the element moves its focus.
 */

const RENDERER = fileURLToPath(new URL('../../', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('../../../../../../../', import.meta.url));

/**
 * The one list of files whose key handlers need no `ownKeys`, each for its reason: plain fields (input, textarea,
 * contenteditable), whose keys the window's keys leave alone anyway (`windowKeepsKey`).
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'link/components/ResourceLibrary.tsx': '搜索输入框',
  'link/components/LightingMidiSettings.tsx': '数字输入框：Enter 确认',
  'link/components/BeautyControls.tsx': '数字输入框，在人像美颜里（整页 ownKeys("*")）'
};

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extensions);
    return extensions.some(extension => entry.name.endsWith(extension)) ? [path] : [];
  });
}
const read = (extensions: readonly string[]) => sourceFiles(RENDERER, extensions).filter(path => !path.includes('.test.'))
  .map(path => ({ path, name: relative(RENDERER, path).split(sep).join('/'), source: readFileSync(path, 'utf8').replace(/\r\n/g, '\n') }));

it('每个自己处理按键（onKeyDown=、onKeyUp=）的界面文件都用 ownKeys 说明哪些键归它，或者在上面写明原因的名单里（04 设计 K3、K9）', () => {
  const files = read(['.tsx']);
  const handling = files.filter(file => /onKey(?:Down|Up)=/.test(file.source));
  expect(handling.length).toBeGreaterThan(10);
  const missing = handling.filter(file => !file.source.includes('ownKeys(') && ALLOWED[file.name] === undefined).map(file => file.name);
  expect(missing).toEqual([]);
  // The list stays short and true: every file on it still handles keys and still has no `ownKeys`.
  const stale = Object.keys(ALLOWED).filter(name => {
    const file = files.find(entry => entry.name === name);
    return file === undefined || !/onKey(?:Down|Up)=/.test(file.source) || file.source.includes('ownKeys(');
  });
  expect(stale).toEqual([]);
});

/** `KEY_LISTENER_RESTRICTIONS` alone, the way eslint.config.mjs applies it, without the type-checked rules. */
const linter = new Linter({ configType: 'flat' });
const lintKeys = (source: string, file: string): string[] => linter.verify(source, [{
  files: ['**/*.{ts,tsx}'],
  languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  rules: { 'no-restricted-syntax': ['error', ...KEY_LISTENER_RESTRICTIONS] }
}], file).map(message => `${file}:${message.line} ${message.message}`);

it('按键监听只在 link/keys/：别处往 window、document 或元素上加 keydown、keyup 监听，或用 onKeyDownCapture，lint 报错（04 设计 K9）', async () => {
  // Every source but the router's own: none listens to keys.
  const outside = read(['.ts', '.tsx']).filter(file => !file.name.startsWith('link/keys/'));
  expect(outside.length).toBeGreaterThan(100);
  expect(outside.flatMap(file => lintKeys(file.source, file.name))).toEqual([]);
  // What it catches.
  const caught = [
    "window.addEventListener('keydown', () => undefined);",
    'document.addEventListener("keyup", () => undefined, true);',
    "element.addEventListener('keypress', () => undefined);",
    'window.onkeydown = () => undefined;',
    'export const A = () => <div onKeyDownCapture={() => undefined} />;',
    'export const B = () => <div onKeyUpCapture={() => undefined} />;'
  ];
  for (const source of caught) expect(lintKeys(source, 'probe.tsx'), source).toHaveLength(1);
  for (const source of ["window.addEventListener('pointerdown', () => undefined);", 'export const C = () => <input onKeyDown={() => undefined} />;']) {
    expect(lintKeys(source, 'probe.tsx'), source).toEqual([]);
  }
  // The lint config applies it to the renderer, but under link/keys/ and in tests.
  const eslint = new ESLint({ cwd: REPOSITORY });
  const rule = async (path: string): Promise<unknown> => ((await eslint.calculateConfigForFile(path)) as { rules?: Record<string, unknown> }).rules?.['no-restricted-syntax'];
  expect(await rule('apps/desktop/src/renderer/src/link/components/ProgramGrid.tsx')).toEqual([2, ...KEY_LISTENER_RESTRICTIONS]);
  expect(await rule('apps/desktop/src/renderer/src/main.tsx')).toEqual([2, ...KEY_LISTENER_RESTRICTIONS]);
  expect(await rule('apps/desktop/src/renderer/src/link/keys/key-router.ts')).toBeUndefined();
  // The router is the one that listens.
  expect(readFileSync(join(RENDERER, 'link/keys/key-router.ts'), 'utf8')).toMatch(/addEventListener\('keydown'/);
}, 180_000);
