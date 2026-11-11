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
  'components/ResourceLibrary.tsx': '搜索输入框',
  'components/LightingMidiSettings.tsx': '数字输入框：Enter 确认',
  'components/BeautyControls.tsx': '数字输入框，在人像美颜里（整页 ownKeys("*")）',
  'components/ReferenceTimeline.tsx': '时间线自己的键（handleTimelineKey），窗口的键在时间线里本来就不动（K6 接到路由上）'
};

function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, extensions);
    return extensions.some(extension => entry.name.endsWith(extension)) ? [path] : [];
  });
}
const tsxFiles = (directory: string): string[] => sourceFiles(directory, ['.tsx']);

/**
 * The key listeners on the window or the page that are not the router's yet, each for the step that moves it onto the
 * router. No new one is added: a key a component handles is a command it registers (useKeyCommands), a panel Escape
 * closes registers itself (useKeyOverlay, K4), and an element's own keys are declared (`ownKeys`).
 */
const WINDOW_LISTENERS: Readonly<Record<string, string>> = {
  'keys/key-router.ts': '窗口唯一的按键路由',
  'components/drag-session.ts': '拖动中的 Esc（K5 接到路由上）',
  'components/useTimelineStamp.tsx': '灯光工作台的快捷键（K6 接到路由上）',
  'components/LightingTimeline.tsx': '灯光时间线的键（K6 接到路由上）'
};

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

it('窗口和页面上的按键监听只剩路由和名单里等着接到路由上的几处，浮层和弹窗不再自己听 Esc（04 设计 K4）', () => {
  const files = sourceFiles(LINK, ['.ts', '.tsx']).filter(path => !path.includes('.test.')).map(path => ({ name: relative(LINK, path).split(sep).join('/'), source: readFileSync(path, 'utf8') }));
  const listening = (source: string): boolean => /addEventListener\(\s*['"]key(?:down|up)['"]/.test(source);
  expect(files.filter(file => listening(file.source) && WINDOW_LISTENERS[file.name] === undefined).map(file => file.name)).toEqual([]);
  expect(Object.keys(WINDOW_LISTENERS).filter(name => !files.some(file => file.name === name && listening(file.source)))).toEqual([]);
});
