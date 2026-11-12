import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

/*
 * Words from the code in text the operator reads (docs/UI_COPY_GUIDE.md「不出现代码里的概念」, audit root cause 8).
 * Any string literal, template literal or JSX text with Chinese in it counts as text someone reads: the interface,
 * notices, errors and the run log. The scan finds the words below in that text, per file. The copy written before this
 * guard is in the baseline (`user-copy-scan.baseline.json`, file → word → count): a count may only go down. A new
 * word in a file, or one more of a word already there, fails; fewer passes and says how to lower the baseline.
 * Comments, tests and test fixtures are not scanned; `${...}` inside a template is code, not text.
 */

const REPOSITORY = fileURLToPath(new URL('../../../../../../', import.meta.url));
const BASELINE = fileURLToPath(new URL('./user-copy-scan.baseline.json', import.meta.url));
const ROOTS = ['apps/desktop/src', 'packages/core/src', 'packages/schema/src'];

/**
 * Code words, and old words the guide replaced. Words people see on site stay out: Cue, MIDI, MTC, OBS, Show, Timecode,
 * Telnet, executor and device names. 「正式音频」 is the name of a source in OBS and stays (UI_COPY_GUIDE.md).
 */
const CODE_WORDS: readonly string[] = [
  '会话', '代数', '受管', '回读', '档案', '凭证', '脱敏', '通道', '队列', '入队',
  '内部主控', '本软件', '预检', '布防', '未参与', '本首无灯光', '原生保留', '发行方', '编辑代理',
  'session', 'revision', 'snapshot', 'payload', 'IPC', 'preload', 'renderer', 'handler', 'callback', 'schema', 'DTO',
  'undefined', 'null'
];
/** Mixed-case names and units people see on site, which the camelCase check leaves alone. */
const KNOWN_NAMES = new Set(['grandMA2', 'grandMA3', 'onPC', 'loopMIDI', 'macOS', 'iOS', 'iPhone', 'iPad', 'dB', 'kHz']);
/** A camelCase identifier: a lower-case start, then an upper-case letter (`itemId`, `setLightingCommand`). */
const CAMEL = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*(?![A-Za-z0-9_])/g;
const CAMEL_WORD = 'camelCase';
/** A MIDI channel and an MA2 fixture channel are what people see on site; 「通道」 alone is the label of either. */
const SITE_PHRASES = ['MIDI 通道', '灯具或通道'];
const siteText = (text: string): string => text.trim() === '通道' ? '' : SITE_PHRASES.reduce((value, phrase) => value.replaceAll(phrase, ''), text);
const HAN = /[\u3400-\u9fff]/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'fixtures' || entry.name === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The text of every literal with Chinese in it. */
function texts(path: string, source: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(' ');
    // A script run on the computer (PowerShell, its `$variables` over several lines) is code, whatever its messages say.
    if (text !== null) { if (HAN.test(text) && !(text.includes('\n') && /\$[A-Za-z]/.test(text))) found.push(text); return; }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const words = CODE_WORDS.map(word => ({ word, pattern: /^[\x20-\x7e]+$/.test(word)
  // As written: 「Session」 is a word of the MA2 network people see on the console, 「session」 one of the code.
  ? new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`, 'g')
  : new RegExp(word, 'g') }));

type Counts = Record<string, Record<string, number>>;
function scan(): Counts {
  const counts: Counts = {};
  for (const root of ROOTS) for (const path of sourceFiles(join(REPOSITORY, root))) {
    const name = relative(REPOSITORY, path).split(sep).join('/');
    for (const text of texts(path, readFileSync(path, 'utf8')).map(siteText)) {
      const add = (word: string, count: number) => { if (count) (counts[name] ??= {})[word] = (counts[name]?.[word] ?? 0) + count; };
      for (const { word, pattern } of words) add(word, text.match(pattern)?.length ?? 0);
      add(CAMEL_WORD, (text.match(CAMEL) ?? []).filter(match => !KNOWN_NAMES.has(match)).length);
    }
  }
  return counts;
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(Object.keys(counts).sort().map(file => [file, Object.fromEntries(Object.keys(counts[file]!).sort().map(word => [word, counts[file]![word]!]))]));
}

it('给人看的文字里不新添代码里的词：每个文件每个词只能比基线少，不能多（docs/UI_COPY_GUIDE.md）', { timeout: 60000 }, () => {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Counts;
  const now = scan();
  const grown: string[] = [], lower: Counts = {};
  let shrunk = 0;
  for (const [file, entries] of Object.entries(now)) for (const [word, count] of Object.entries(entries)) {
    const allowed = baseline[file]?.[word] ?? 0;
    if (count > allowed) grown.push(`${file}「${word}」${allowed} → ${count}`);
  }
  for (const [file, entries] of Object.entries(baseline)) for (const [word, allowed] of Object.entries(entries)) {
    const count = Math.min(now[file]?.[word] ?? 0, allowed);
    if (count < allowed) shrunk += 1;
    if (count) (lower[file] ??= {})[word] = count;
  }
  if (shrunk) {
    // Lowering only: never raises a count or adds a pair, so it cannot let new words in.
    if (process.env.TB_COPY_BASELINE === 'lower') writeFileSync(BASELINE, `${JSON.stringify(sorted(lower), null, 2)}\n`);
    else console.info(`给人看的文字里少了 ${shrunk} 处代码里的词。运行 TB_COPY_BASELINE=lower pnpm exec vitest run ${relative(REPOSITORY, fileURLToPath(import.meta.url)).split(sep).join('/')} 把基线调低，和改动一起提交。`);
  }
  expect(grown, '这些文件给人看的文字里多了代码里的词：换成日常说法（docs/UI_COPY_GUIDE.md）').toEqual([]);
});
