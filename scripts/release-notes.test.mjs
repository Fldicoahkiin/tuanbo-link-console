import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareVersions, notesUpTo, parseReleaseNotes, readReleaseNotes, renderChangelog, renderMarkdown } from './release-notes.mjs';

const root = new URL('../', import.meta.url);
const packageVersion = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
const notes = readReleaseNotes(fileURLToPath(new URL('release-notes/', root)));

test('每个 release-notes 文件都能解析，当前版本有自己的更新日志', () => {
  assert.ok(notes.length > 0);
  assert.ok(notes.some(note => note.version === packageVersion), `缺少 release-notes/${packageVersion}.md`);
});

test('CHANGELOG.md 与 release-notes/ 一致', () => {
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(changelog, renderChangelog(notes, packageVersion), 'CHANGELOG.md 和 release-notes/ 不一致：运行 pnpm changelog 后一起提交');
});

test('按数字比较版本号，只取不高于给定版本的条目', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.5.2', '0.5.2'), 0);
  assert.throws(() => compareVersions('0.5', '0.5.0'), /不是 X\.Y\.Z/);
  const sample = ['0.5.3', '0.5.2', '0.5.0'].map(version => parseReleaseNotes(version, '- 内容'));
  assert.deepEqual(notesUpTo(sample, '0.5.2').map(note => note.version), ['0.5.2', '0.5.0']);
});

test('解析段落、小标题、列表和加粗，并按原样写回 Markdown', () => {
  const text = '一段说明。\n\n## 灯光\n\n- **同步**：以时间线为准。\n- 第二条\n\n结尾说明。\n';
  const note = parseReleaseNotes('1.2.3', text.replace(/\n/g, '\r\n'));
  assert.deepEqual(note.blocks, [
    { kind: 'paragraph', content: [{ text: '一段说明。', strong: false }] },
    { kind: 'heading', text: '灯光' },
    { kind: 'list', items: [[{ text: '同步', strong: true }, { text: '：以时间线为准。', strong: false }], [{ text: '第二条', strong: false }]] },
    { kind: 'paragraph', content: [{ text: '结尾说明。', strong: false }] }
  ]);
  assert.equal(renderMarkdown(note), text.trimEnd());
});

test('拒绝其他 Markdown 写法并指出文件和行号', () => {
  for (const [text, message] of [
    ['- 第一条\n接着写', /第 2 行：每段或每个列表项写在一行内/],
    ['第一行\n第二行', /第 2 行：每段或每个列表项写在一行内/],
    ['### 三级标题', /第 1 行：.*写法不支持/],
    ['1. 编号列表', /第 1 行：.*写法不支持/],
    ['* 星号列表', /第 1 行：.*写法不支持/],
    ['  - 缩进列表', /第 1 行：.*写法不支持/],
    ['- **没有成对', /第 1 行：\*\*加粗\*\* 没有成对/],
    ['- 见[官网](https://example.com)', /不能用链接/],
    ['- 运行 `pnpm dev`', /不能用链接、代码/],
    ['- <b>HTML</b>', /HTML/],
    ['- 单个*星号', /单个星号/],
    ['\n\n', /是空的/]
  ]) assert.throws(() => parseReleaseNotes('0.0.1', text), message, text);
});
