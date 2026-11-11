import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/*
 * The window's key router takes every key first, in the capture phase (key-router.ts, 04 设计 K3). An element that
 * acts on keys itself (`onKeyDown=`) has to say which keys are its own (`ownKeys`, key-owner.ts), or the window's
 * keys act before it: Space plays, Escape stops, ↑↓ change songs while the element moves its focus. This scan keeps
 * every new key handler to that rule. The few files left out below say why.
 */

const LINK = fileURLToPath(new URL('..', import.meta.url));

/**
 * Files whose key handlers need no `ownKeys`, each for its reason. Plain fields (input, textarea, contenteditable),
 * whose keys the window's keys leave alone anyway (`windowKeepsKey`), and the timeline, whose keys the window's never
 * reached.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'components/PropertyNumberInput.tsx': '数字输入框：Enter、Esc 和上下键都在输入框里',
  'components/LightingArrangementSettings.tsx': '数字输入框：Enter 确认',
  'components/CueRundownHeader.tsx': '改名输入框：Enter、Esc',
  'components/ResourceLibrary.tsx': '搜索输入框',
  'components/LightingMidiSettings.tsx': '数字输入框：Enter 确认',
  'components/BeautyControls.tsx': '数字输入框，在人像美颜里（整页 ownKeys("*")）',
  'components/ReferenceTimeline.tsx': '时间线自己的键（handleTimelineKey），窗口的键在时间线里本来就不动（K6 接到路由上）'
};

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

it('每个自己处理按键（onKeyDown=）的界面文件都用 ownKeys 说明哪些键归它，或者在上面写明原因的名单里（04 设计 K3）', () => {
  const files = tsxFiles(LINK).map(path => ({ name: relative(LINK, path).split(sep).join('/'), source: readFileSync(path, 'utf8').replace(/\r\n/g, '\n') }));
  const handling = files.filter(file => file.source.includes('onKeyDown='));
  expect(handling.length).toBeGreaterThan(10);
  const missing = handling.filter(file => !file.source.includes('ownKeys(') && ALLOWED[file.name] === undefined).map(file => file.name);
  expect(missing).toEqual([]);
  // The list stays short and true: every file on it still handles keys and still has no `ownKeys`.
  const stale = Object.keys(ALLOWED).filter(name => {
    const file = files.find(entry => entry.name === name);
    return file === undefined || !file.source.includes('onKeyDown=') || file.source.includes('ownKeys(');
  });
  expect(stale).toEqual([]);
});
