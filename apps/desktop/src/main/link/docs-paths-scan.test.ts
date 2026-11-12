import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The current documents (docs/ARCHITECTURE.md 第 12 节) say where each thing is decided, by file. A file that was moved,
 * renamed or deleted leaves them pointing nowhere, and whoever reads them next (a person or a model) writes a second
 * implementation because the first cannot be found. This reads every path written as code and every relative link in
 * those documents and fails for the ones that are not in the repository.
 */

const REPOSITORY = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The documents that are kept true to the code; the dated records under docs/ are not read. */
const DOCUMENTS = [
  'AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/ARCHITECTURE.md', 'docs/ONE_PLACE_PLAYBACK.md', 'docs/ONE_PLACE_PICTURE.md', 'docs/ONE_PLACE_LIGHTING.md',
  'docs/ONE_PLACE_EDITOR.md', 'docs/LIGHTING_WORKFLOW.md', 'docs/OBS_SCENE_WORKFLOW.md', 'docs/OBS_REALTIME_CANVAS.md',
  'docs/KEYBOARD_SHORTCUTS.md', 'docs/SONG_VOLUME.md', 'docs/UI_COPY_GUIDE.md', 'docs/LICENSE_IMPLEMENTATION.md', 'docs/RELEASE_CHAIN.md',
  'release-notes/README.md', 'docs/plan.md'
] as const;

/** Where a path in a document may start from, besides the repository root and the document's own folder. */
const BASES = ['apps/desktop/src/main/link/', 'apps/desktop/src/main/', 'apps/desktop/src/renderer/src/link/', 'apps/desktop/src/renderer/src/',
  'apps/desktop/', 'apps/licensing-server/', 'packages/core/src/', 'packages/schema/src/', 'docs/'] as const;

/** Written as code and shaped like a path, but not a file of this repository; each with why. */
const NOT_IN_REPOSITORY: readonly RegExp[] = [
  /X\.Y\.Z/, // 版本号的占位
  /^0\.5\.1\.md$/, // release-notes/README.md 写的是“没有这个文件”
  /^(?:latest\.yml|update-status\.json|result\.json)$/, // 更新源上的文件和验收时生成的结果
  /^(?:artifacts|userData|acceptance-[^/]+|cache)\//, // 构建产物、本机数据、验收记录、工程旁边的缓存
  /^\.claude\// // 用户自己电脑上的设置
];

/** Named in a document as deleted, in a sentence that says so. Add a file here only with that sentence in the document. */
const DELETED = new Set(['runtime/song-volume-sync.ts']);

const FILE = /\.(?:ts|tsx|mts|mjs|cjs|css|lua|ps1|md|yml|json)$/;

/** The paths `text` writes as code (`like/this.ts`, `a/folder/`) and its relative links. */
function pathsIn(text: string): { code: string[]; links: string[] } {
  const code = new Set<string>(), links = new Set<string>();
  for (const [, token] of text.matchAll(/`([^`\n]+)`/g)) {
    if (token === undefined || /[\s<>*…{}$=|()，、；]/.test(token) || /^(?:~|\/|[A-Za-z]:\\|https?:|link:|@|--)/.test(token)) continue;
    const path = token.replace(/[#:].*$/, '');
    if (FILE.test(path) || path.includes('/') && path.endsWith('/')) code.add(path);
  }
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (target !== undefined && !/^(?:https?:|mailto:|#)/.test(target)) links.add(target.replace(/#.*$/, ''));
  }
  return { code: [...code], links: [...links] };
}

/** Every file name under the folders the documents talk about. */
function fileNames(): Set<string> {
  const names = new Set<string>();
  const skipped = new Set(['node_modules', 'dist', 'out', 'release', 'compiler', 'portable', 'coverage']);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(`${REPOSITORY}${directory}`, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!skipped.has(entry.name) && !entry.name.startsWith('.git')) walk(`${directory}${entry.name}/`); }
      else names.add(entry.name);
    }
  };
  for (const root of ['', 'apps/', 'packages/', 'scripts/', 'tools/', 'docs/', 'release-notes/', '.github/']) {
    if (root === '') for (const entry of readdirSync(REPOSITORY, { withFileTypes: true })) { if (entry.isFile()) names.add(entry.name); }
    else walk(root);
  }
  return names;
}

/** What `document` (with this `text`) points at that is not there. */
function missingIn(document: string, text: string, names: ReadonlySet<string>): string[] {
  const { code, links } = pathsIn(text);
  const from = dirname(`${REPOSITORY}${document}`);
  const found = (path: string): boolean => path.includes('/')
    ? existsSync(resolve(REPOSITORY, path)) || existsSync(resolve(from, path)) || BASES.some(base => existsSync(resolve(REPOSITORY, base, path)))
    : names.has(path);
  return [
    ...code.filter(path => !DELETED.has(path) && !NOT_IN_REPOSITORY.some(pattern => pattern.test(path)) && !found(path)),
    ...links.filter(target => !existsSync(resolve(from, target))).map(target => `链接 ${target}`)
  ];
}

/** The rows of AGENTS.md「同一件事只有一处实现」: what, where it is decided, the tests that guard it, the link to its rules. */
function onePlaceRows(agents: string): { title: string; where: string; tests: string; detail: string }[] {
  // A checkout on Windows ends its lines with CRLF.
  const lines = agents.split(/\r?\n/);
  const start = lines.indexOf('| 事情 | 唯一的地方 | 守着它的测试 | 细节 |');
  const rows: { title: string; where: string; tests: string; detail: string }[] = [];
  for (let index = start + 2; start >= 0 && lines[index]?.startsWith('|') === true; index += 1) {
    const [, title = '', where = '', tests = '', detail = '', ...rest] = (lines[index] ?? '').split('|').map(cell => cell.trim());
    rows.push({ title, where, tests, detail: rest.length === 1 ? detail : '' });
  }
  return rows;
}

/** What is wrong with a row: no place, no test, or no section with its rules. `sectionsOf` reads a document's `## ` headings. */
function rowProblems(row: ReturnType<typeof onePlaceRows>[number], sectionsOf: (document: string) => readonly string[]): string[] {
  const problems: string[] = [];
  if (pathsIn(row.where).code.length === 0) problems.push('没写在哪个文件');
  if (!pathsIn(row.tests).code.some(path => /\.test\.tsx?$/.test(path))) problems.push('没写哪个测试守着');
  const link = /^\[[^\]]+\]\(\.\/(docs\/ONE_PLACE_[A-Z]+\.md)#[^)]+\)$/.exec(row.detail);
  if (link?.[1] === undefined) problems.push('细节要链接到 docs/ONE_PLACE_*.md 里它的那一节');
  else if (!sectionsOf(link[1]).includes(row.title)) problems.push(`${link[1]} 里没有「${row.title}」这一节`);
  return problems.map(problem => `${row.title}：${problem}`);
}

describe('现行文档里写到的文件都在（2026-11-12）', () => {
  it('写成代码的路径和文档之间的链接都找得到文件', () => {
    const names = fileNames();
    let read = 0;
    const missing = DOCUMENTS.flatMap(document => {
      const text = readFileSync(`${REPOSITORY}${document}`, 'utf8');
      const { code, links } = pathsIn(text);
      read += code.length + links.length;
      return missingIn(document, text, names).map(path => `${document}：${path}`);
    });
    // 文件搬了、改名了：把文档改成新的位置。文件是有意删掉的：文档里写明已删掉，再加进上面的 DELETED。
    expect(missing).toEqual([]);
    // The documents were really read.
    expect(read).toBeGreaterThan(400);
  });

  it('AGENTS.md「同一件事只有一处实现」每一行都写了在哪、哪个测试守着，规矩的全文那一节存在', () => {
    const sectionsOf = (document: string): string[] => readFileSync(`${REPOSITORY}${document}`, 'utf8').split('\n')
      .filter(line => line.startsWith('## ')).map(line => line.slice(3).trim());
    const rows = onePlaceRows(readFileSync(`${REPOSITORY}AGENTS.md`, 'utf8'));
    expect(rows.flatMap(row => rowProblems(row, sectionsOf))).toEqual([]);
    // 这张表只加不减：2026-11-12 是 36 行。
    expect(rows.length).toBeGreaterThanOrEqual(36);
    expect(new Set(rows.map(row => row.title)).size).toBe(rows.length);

    const sample = (cells: string): string => ['| 事情 | 唯一的地方 | 守着它的测试 | 细节 |', '| --- | --- | --- | --- |', cells].join('\n');
    const sections = (): string[] => ['怎么认控台'];
    const good = '| 怎么认控台 | 只按编号认（`packages/core/src/ma2-console-identity.ts`） | `packages/core/src/ma2-console-identity.test.ts` | [灯光和 MA2](./docs/ONE_PLACE_LIGHTING.md#怎么认控台) |';
    expect(onePlaceRows(sample(good)).flatMap(row => rowProblems(row, sections))).toEqual([]);
    // The same table as a checkout on Windows has it.
    const windows = onePlaceRows(sample(good).replace(/\n/g, '\r\n'));
    expect(windows.map(row => row.title)).toEqual(['怎么认控台']);
    expect(windows.flatMap(row => rowProblems(row, sections))).toEqual([]);
    expect(onePlaceRows(sample(good.replace('`packages/core/src/ma2-console-identity.test.ts`', '还没有'))).flatMap(row => rowProblems(row, sections))).toEqual(['怎么认控台：没写哪个测试守着']);
    expect(onePlaceRows(sample(good.replace('（`packages/core/src/ma2-console-identity.ts`）', ''))).flatMap(row => rowProblems(row, sections))).toEqual(['怎么认控台：没写在哪个文件']);
    expect(onePlaceRows(sample(good)).flatMap(row => rowProblems(row, () => []))).toEqual(['怎么认控台：docs/ONE_PLACE_LIGHTING.md 里没有「怎么认控台」这一节']);
    expect(onePlaceRows(sample(good.replace(/ \| \[灯光.*$/, ' |'))).flatMap(row => rowProblems(row, sections))).toEqual(['怎么认控台：细节要链接到 docs/ONE_PLACE_*.md 里它的那一节']);
  });

  it('认得出不存在的文件；命令、通道名、带占位符的写法不当成路径', () => {
    const names = new Set(['program-start.ts']);
    const text = [
      '规则在 `packages/core/src/program-start.ts`，接线在 `link-main.ts` 和 `stores/document-store.ts:12`，说明见 [灯光](./docs/LIGHTING_WORKFLOW.md#同步规则)。',
      '旧的 `packages/core/src/no-such-rule.ts`、`runtime/no-such-store.ts`、`no-such-file.ts`、`apps/desktop/src/no-such-folder/` 和 [旧文档](./docs/NO_SUCH.md) 都不在。',
      '不是路径：`pnpm exec vitest run`、`link:native-program-document`、`cache/waveforms/<sha>.levels.bin`、`release-notes/X.Y.Z.md`、`~/.config/tblink-remote/`、`@tb/core/link`。'
    ].join('\n');
    expect(pathsIn(text).code).toEqual(['packages/core/src/program-start.ts', 'link-main.ts', 'stores/document-store.ts', 'packages/core/src/no-such-rule.ts',
      'runtime/no-such-store.ts', 'no-such-file.ts', 'apps/desktop/src/no-such-folder/', 'release-notes/X.Y.Z.md']);
    expect(missingIn('AGENTS.md', text, names)).toEqual(['link-main.ts', 'packages/core/src/no-such-rule.ts', 'runtime/no-such-store.ts', 'no-such-file.ts',
      'apps/desktop/src/no-such-folder/', '链接 ./docs/NO_SUCH.md']);
    expect(missingIn('AGENTS.md', text, fileNames())).toEqual(['packages/core/src/no-such-rule.ts', 'runtime/no-such-store.ts', 'no-such-file.ts',
      'apps/desktop/src/no-such-folder/', '链接 ./docs/NO_SUCH.md']);
  });
});
