// Release notes are written once, in release-notes/X.Y.Z.md. Everything else reads them:
//   GitHub release body   scripts/draft-github-release.mjs
//   CHANGELOG.md          scripts/write-changelog.mjs (checked by scripts/release-notes.test.mjs)
//   website download page apps/licensing-server/build-web.mjs, versions up to web/release.json
//   desktop update panel  apps/desktop/electron.vite.config.ts, versions up to the app's own version
// The files use a small Markdown subset so every reader renders them the same way: one-line paragraphs,
// "## " headings, one-line "- " list items and **bold**. Anything else is refused with its file and line.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const NOTE_FILE = /^(\d+\.\d+\.\d+)\.md$/;
const UNSUPPORTED_LINE = /^(?:#|\d+[.)]\s|[*+]\s|>|```|\||\s)/;
const UNSUPPORTED_INLINE = /[`<>[\]\\]|!\[/;

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function parseReleaseNotes(version, text) {
  parseVersion(version);
  const blocks = [];
  let list = null;
  let previousBlank = true;
  text.replace(/\r\n/g, '\n').split('\n').forEach((raw, index) => {
    const line = raw.trimEnd();
    const where = `release-notes/${version}.md 第 ${index + 1} 行`;
    if (!line) { list = null; previousBlank = true; return; }
    if (line.startsWith('## ')) {
      blocks.push({ kind: 'heading', text: plainText(line.slice(3).trim(), where) });
      list = null;
    } else if (line.startsWith('- ')) {
      if (!list) { list = { kind: 'list', items: [] }; blocks.push(list); }
      list.items.push(inline(line.slice(2).trim(), where));
    } else if (UNSUPPORTED_LINE.test(line)) {
      throw new Error(`${where}：更新日志只支持一行一段、「## 」标题、「- 」列表和 **加粗**，这一行的写法不支持`);
    } else if (!previousBlank) {
      throw new Error(`${where}：每段或每个列表项写在一行内，段落之间空一行`);
    } else {
      blocks.push({ kind: 'paragraph', content: inline(line, where) });
    }
    previousBlank = false;
  });
  if (!blocks.length) throw new Error(`release-notes/${version}.md 是空的`);
  return { version, blocks };
}

/** Every release-notes/X.Y.Z.md, newest first. Only README.md may sit beside them. */
export function readReleaseNotes(directory) {
  const notes = [];
  for (const name of readdirSync(directory)) {
    if (name === 'README.md') continue;
    const match = NOTE_FILE.exec(name);
    if (!match?.[1]) throw new Error(`release-notes/${name} 不是 X.Y.Z.md 形式的更新日志`);
    notes.push(parseReleaseNotes(match[1], readFileSync(join(directory, name), 'utf8')));
  }
  return notes.sort((a, b) => compareVersions(b.version, a.version));
}

/** The notes a build of `version` can show: that version and every earlier one. */
export function notesUpTo(notes, version) {
  return notes.filter(note => compareVersions(note.version, version) <= 0);
}

/** The repository's CHANGELOG.md. Versions above the package version are marked as not yet released. */
export function renderChangelog(notes, packageVersion) {
  const sections = notes.map(note => {
    const label = compareVersions(note.version, packageVersion) > 0 ? `${note.version}（未发布）` : note.version;
    return [`## ${label}`, ...note.blocks.map(block => renderMarkdownBlock(block, '###'))].join('\n\n');
  });
  return [
    '# 更新日志',
    '本文件由 `pnpm changelog` 根据 [release-notes/](release-notes/) 生成，不要直接修改。写法和发版时的用法见 [release-notes/README.md](release-notes/README.md)。',
    ...sections,
    '更早的测试版本（0.4.27 及以前）只在 [GitHub Releases](https://github.com/Fldicoahkiin/tuanbo-link-console/releases) 里有说明。'
  ].join('\n\n') + '\n';
}

/** The release-notes file as Markdown, normalized: used for the GitHub release body. */
export function renderMarkdown(note) {
  return note.blocks.map(block => renderMarkdownBlock(block, '##')).join('\n\n');
}

function renderMarkdownBlock(block, heading) {
  switch (block.kind) {
    case 'heading': return `${heading} ${block.text}`;
    case 'paragraph': return renderInline(block.content);
    case 'list': return block.items.map(item => `- ${renderInline(item)}`).join('\n');
    default: throw new Error(`未知的更新日志内容：${JSON.stringify(block)}`);
  }
}

function renderInline(content) {
  return content.map(part => part.strong ? `**${part.text}**` : part.text).join('');
}

function inline(text, where) {
  const parts = text.split('**');
  if (parts.length % 2 === 0) throw new Error(`${where}：**加粗** 没有成对`);
  const content = [];
  parts.forEach((part, index) => {
    const strong = index % 2 === 1;
    if (strong && !part.trim()) throw new Error(`${where}：**加粗** 里没有文字`);
    if (part) content.push({ text: plainText(part, where), strong });
  });
  if (!content.length) throw new Error(`${where}：这一行没有文字`);
  return content;
}

function plainText(text, where) {
  if (!text) throw new Error(`${where}：这一行没有文字`);
  if (text.includes('*') || UNSUPPORTED_INLINE.test(text)) {
    throw new Error(`${where}：更新日志里不能用链接、代码、HTML、图片、反斜杠或单个星号`);
  }
  return text;
}

function parseVersion(version) {
  const match = typeof version === 'string' ? VERSION.exec(version) : null;
  if (!match) throw new Error(`版本号 ${String(version)} 不是 X.Y.Z`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
