import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject, type Ma2ExecutorInput } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';
import { launchExecutorFixture } from './ma2-executor-fixture';
import { closeDiscarding } from './save-questions';

/*
 * Keys held down, keys pressed in a dialog and drags cancelled with Escape, in the built app (0.5.9). The unit tests
 * guard the decisions (playback-keys, timeline-keys, drag-session, ma2-executor-keys, cue-point-keys); these guard the
 * components that call them. Local only, like every e2e spec: CI does not run them.
 */

const SECONDS = 60;

function wave(): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(44 + rate * SECONDS, 128);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate, 28); data.writeUInt16LE(1, 32); data.writeUInt16LE(8, 34);
  data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  for (let sample = 0; sample < rate * SECONDS; sample++) data.writeUInt8(128 + Math.round(60 * Math.sin(sample * 0.05) * ((sample % 4000) < 1500 ? 1 : 0.2)), 44 + sample);
  return data;
}

type Song = { id: string; title: string; audio: boolean; enabled?: boolean; lighting?: boolean; layers?: boolean; shortcut?: string };

/**
 * Opens a show of `songs`: a minute of audio each, a lighting Cue at `cueAtMs`, two camera tracks, a song's own
 * shortcut; `arrowKeys` turns on ↑↓ changing songs on this computer first.
 */
async function open(info: TestInfo, songs: Song[], options: { cueAtMs?: number; source?: 'internal' | 'p1'; arrowKeys?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const audio = wave();
  const sha256 = createHash('sha256').update(audio).digest('hex');
  await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
  await writeFile(info.outputPath('assets/reference-audio/audio.wav'), audio);
  const lighting = createLightingDocument();
  lighting.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
    clips: [{ id: 'clip', name: '灯光', start: 0, duration: SECONDS * 1000, timeLock: 'time', muted: false,
      events: [{ id: 'point', kind: 'ma2', action: 'goto', at: options.cueAtMs ?? 1000, cue: '1.000', sequence: 1, executor: '1.101', label: '第一步' }] }] })];
  const project = parseLinkProject({ ...createEmptyLinkProject('按键与拖动'), schemaVersion: 2, playbackSource: options.source ?? 'internal',
    rundown: songs.map(song => ({ id: song.id, title: song.title, enabled: song.enabled ?? true, cues: [],
      ...(song.lighting ? { lighting } : {}),
      ...(song.layers ? { visualLayers: [{ id: 'layer-1', name: '图层一' }, { id: 'layer-2', name: '图层二' }],
        cues: [{ id: 'cue-1', name: '机位一', timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 }, durationMs: 2000, layerId: 'layer-1' },
          { id: 'cue-2', name: '机位二', timecode: { hours: 0, minutes: 0, seconds: 5, frames: 0 }, durationMs: 2000, layerId: 'layer-2' }] } : {}),
      ...(song.shortcut ? { playback: { volume: 100, startMs: 0, endMs: SECONDS * 1000, mtcOffsetMs: 0, shortcut: song.shortcut } } : {}),
      ...(song.audio ? { referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/audio.wav', sha256, durationMs: SECONDS * 1000 } } : {}) })) });
  const file = info.outputPath('keys.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, dialog }, path) => {
    BrowserWindow.getAllWindows()[0]!.setSize(1600, 1000);
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false });
  }, file);
  if (options.arrowKeys) {
    await page.waitForFunction(() => Boolean(window.tbLink));
    const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
    profile.internalPlayer = { arrowKeyPlayback: true, mtcOutputPortProfileId: null, audioOutputDeviceId: 'default' };
    await page.evaluate(value => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.tbLink));
  }
  await page.getByRole('button', { name: '打开工程', exact: true }).click();
  await expect(page.locator('.home-card').first()).toBeVisible();
  return { app, page };
}

/** Holds `key` down: one keydown, `repeats` repeated keydowns, then the keyup. */
async function hold(page: Page, key: string, repeats: number): Promise<void> {
  await page.keyboard.down(key);
  for (let index = 0; index < repeats; index++) { await page.waitForTimeout(40); await page.keyboard.down(key); }
  await page.waitForTimeout(40);
  await page.keyboard.up(key);
  await page.waitForTimeout(400);
}

/** Counts the clicks `button` gets from now on. */
async function countClicks(button: Locator): Promise<() => Promise<number>> {
  await button.evaluate(element => {
    Reflect.set(window, '__clicks', 0);
    element.addEventListener('click', () => Reflect.set(window, '__clicks', Number(Reflect.get(window, '__clicks')) + 1));
  });
  return () => button.page().evaluate(() => Number(Reflect.get(window, '__clicks')));
}

/** Counts the Escape presses that get through to the window, where Escape stops the show. */
async function countEscapes(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    Reflect.set(window, '__escapes', 0);
    window.addEventListener('keydown', event => { if (event.key === 'Escape') Reflect.set(window, '__escapes', Number(Reflect.get(window, '__escapes')) + 1); });
  });
  return () => page.evaluate(() => Number(Reflect.get(window, '__escapes')));
}

/**
 * Writes down what the window asks the show in the main process (联动台播放) to do from now on: play, stop, skip to
 * another song, seek. No sound plays on Linux, so a stop or skip reaching the main process is what "the show stopped" means.
 */
async function recordTransport(app: ElectronApplication): Promise<{ asked: () => Promise<string[]>; clear: () => Promise<void> }> {
  await app.evaluate(({ ipcMain }) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (event: unknown, request: unknown) => unknown>;
    const control = handlers.get('link:native-program-control');
    if (!control) throw new Error('主进程没有节目控制的处理');
    const asked: string[] = []; Reflect.set(globalThis, '__transport', asked);
    handlers.set('link:native-program-control', (event, request) => {
      const kind: unknown = Reflect.get(Object(Reflect.get(Object(request), 'operation')), 'kind');
      if (typeof kind === 'string' && ['play', 'pause', 'resume', 'stop', 'reset', 'toggle', 'seek', 'scrub', 'skip'].includes(kind)) asked.push(kind);
      return control(event, request);
    });
  });
  return {
    asked: () => app.evaluate(() => [...(Reflect.get(globalThis, '__transport') as string[])]),
    clear: () => app.evaluate(() => { (Reflect.get(globalThis, '__transport') as string[]).length = 0; })
  };
}

/** Opens 「MTC 时间码状态」 from the title bar's 详细. */
async function mtcStatus(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^详细/ }).click();
  await page.getByRole('button', { name: /^MTC 状态/ }).click();
  await expect(page.locator('dialog.ui-dialog[open]')).toHaveCount(1);
}

/** Three songs, the third with its own shortcut Ctrl+3. */
const threeSongs: Song[] = [{ id: 'song-a', title: '第一首', audio: true }, { id: 'song-b', title: '第二首', audio: true }, { id: 'song-c', title: '第三首', audio: true, shortcut: 'Ctrl+Digit3' }];

/** The lighting workbench without snapping, zoomed in `zoom` steps. */
async function lightingWorkbench(page: Page, zoom = 0): Promise<Locator> {
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
  const snap = page.getByRole('button', { name: '关闭吸附', exact: true });
  if (await snap.count()) await snap.click();
  for (let index = 0; index < zoom; index++) { await page.getByRole('button', { name: '放大时间线', exact: true }).click(); await page.waitForTimeout(200); }
  const point = page.getByRole('button', { name: '音频 Cue 1', exact: true });
  await expect(point).toBeVisible();
  return point;
}

/** Presses the Cue point and drags it to `x` (page pixels), the pointer still held. */
async function pressAndDrag(page: Page, point: Locator, x: (box: { x: number; width: number }) => Promise<number>): Promise<void> {
  const box = (await point.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(await x(box), box.y + box.height / 2, { steps: 16 });
}
const leftOfTimeline = (page: Page) => async (): Promise<number> => (await page.locator('.timeline-viewport').boundingBox())!.x - 120;
const left = (element: Locator): Promise<number> => element.evaluate(node => parseFloat((node as HTMLElement).style.left));

test('首页点过「下一首」后按住空格：不会松手时再点到「下一首」，焦点留在按钮上', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true }, { id: 'song-d', title: '第四首', audio: true }]);
  try {
    const next = page.locator('.home-transport').getByRole('button', { name: '下一首', exact: true });
    await expect(next).toBeEnabled();
    const clicks = await countClicks(next);
    await next.focus();
    await hold(page, 'Space', 3);
    expect(await clicks()).toBe(0);
    await expect(next).toBeFocused();
  } finally { await closeDiscarding(app); }
});

test('灯光工作台焦点在「定位」上按住空格：「定位」不会被点到，框选照旧', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }]);
  try {
    await lightingWorkbench(page);
    const modes = page.locator('.cue-mouse-modes');
    const seek = modes.getByRole('button', { name: '定位', exact: true }), select = modes.getByRole('button', { name: '框选 Cue', exact: true });
    await select.click();
    await expect(select).toHaveAttribute('aria-pressed', 'true');
    const clicks = await countClicks(seek);
    await seek.focus();
    await hold(page, 'Space', 3);
    expect(await clicks()).toBe(0);
    await expect(seek).toHaveAttribute('aria-pressed', 'false');
  } finally { await closeDiscarding(app); }
});

test('编辑器时间线（P1 跟随下的本地预览）按住空格：只播放一次，不会每个重复的按键都切一次', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true }], { source: 'p1' });
  try {
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const play = page.locator('.timeline-transport .timeline-play-button');
    await expect(play).toBeVisible();
    await play.evaluate(element => {
      const labels: string[] = [element.getAttribute('aria-label') ?? ''];
      Reflect.set(window, '__labels', labels);
      new MutationObserver(() => { const label = element.getAttribute('aria-label') ?? ''; if (labels.at(-1) !== label) labels.push(label); }).observe(element, { attributes: true, attributeFilter: ['aria-label'] });
    });
    await page.locator('.timeline-transport').getByRole('button', { name: '回到时间线开头', exact: true }).focus();
    await hold(page, 'Space', 3);
    expect(await page.evaluate((): unknown => Reflect.get(window, '__labels'))).toEqual(['播放时间线', '暂停时间线']);
  } finally { await closeDiscarding(app); }
});

test('灯光工作台用鼠标点完「框选 Cue」再按 M：在播放头打点，焦点回到时间线', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }]);
  try {
    await lightingWorkbench(page);
    await page.locator('.cue-mouse-modes').getByRole('button', { name: '框选 Cue', exact: true }).click();
    await expect(page.locator('.waveform-cue-point')).toHaveCount(1);
    await page.keyboard.press('m');
    await expect(page.locator('.waveform-cue-point')).toHaveCount(2);
    expect(await page.evaluate(() => document.activeElement?.closest('.reference-timeline') !== null)).toBe(true);
  } finally { await closeDiscarding(app); }
});

test('首页选中的歌没有音频：播放按钮变灰并写明原因，空格只提示原因，不去播别的歌', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-b', title: '第二首', audio: false }, { id: 'song-a', title: '第一首', audio: true }, { id: 'song-c', title: '第三首', audio: true, enabled: false }]);
  try {
    const play = page.locator('.home-player-play');
    await expect(page.locator('.home-player-title')).toHaveText('第二首');
    await expect(play).toBeDisabled();
    await expect(play).toHaveAttribute('title', /“第二首”不能播放，这首歌还没有音频/);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Space');
    await expect(page.locator('.toast', { hasText: '“第二首”不能播放' }).first()).toBeVisible();
    await expect(page.locator('.home-player')).toHaveAttribute('data-status', 'stopped');
  } finally { await closeDiscarding(app); }
});

test('MA2 执行器：Go 键有焦点时按住 Enter 控台只收到一次按下；按住 Flash 时按下一次、松手放开一次', async ({}, info) => {
  test.setTimeout(90_000);
  const { app, page } = await launchExecutorFixture(info);
  try {
    const fader = page.locator('[data-executor-band="fader"]');
    const go = fader.getByRole('button', { name: '执行器 100.1 · 面光_Long_Sequence_Name', exact: true });
    const flash = fader.getByRole('button', { name: '执行器 100.1 Flash', exact: true });
    await expect(go).toBeVisible();
    const inputs = async (): Promise<Ma2ExecutorInput[]> => (JSON.parse(await app.evaluate(() => process.env.TBLINK_EXECUTOR_INPUTS ?? '[]')) as Ma2ExecutorInput[])
      .filter(value => value.slot === 1);
    await go.focus();
    await hold(page, 'Enter', 3);
    await page.waitForTimeout(800);
    expect((await inputs()).filter(value => value.button === 0 && value.pressed)).toHaveLength(1);

    await flash.focus();
    await hold(page, 'Space', 3);
    await expect.poll(async () => (await inputs()).filter(value => value.button === 1).map(value => value.pressed)).toEqual([true, false]);
    await expect(flash).toHaveAttribute('aria-pressed', 'false');
  } finally { await page.evaluate(() => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null })); await app.close(); }
});

test('灯光工作台把 Cue 点拖出看得见的范围后松手：移动照样生效，之后第一下 Esc 照常到窗口（停节目）', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }], { cueAtMs: 30_000 });
  try {
    const point = await lightingWorkbench(page, 2);
    const before = await point.getAttribute('title');
    await pressAndDrag(page, point, leftOfTimeline(page));
    // Out of view, but still on the page: it holds the pointer.
    await expect(page.locator('.waveform-cue-point')).toHaveCount(1);
    await page.mouse.up(); await page.waitForTimeout(300);
    const escapes = await countEscapes(page);
    await page.keyboard.press('Escape');
    expect(await escapes()).toBe(1);
    for (let index = 0; index < 4; index++) { await page.getByRole('button', { name: '缩小时间线', exact: true }).click(); await page.waitForTimeout(200); }
    await page.locator('.timeline-viewport').evaluate(element => { element.scrollLeft = 0; });
    await expect(page.getByRole('button', { name: '音频 Cue 1', exact: true })).toBeVisible();
    expect(await page.getByRole('button', { name: '音频 Cue 1', exact: true }).getAttribute('title')).not.toBe(before);
  } finally { await closeDiscarding(app); }
});

test('灯光工作台把 Cue 点拖出看得见的范围、手还按着时按 Esc：只取消这次移动，不停节目；松手后 Esc 照常到窗口', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }], { cueAtMs: 30_000 });
  try {
    const point = await lightingWorkbench(page, 2);
    const before = await point.getAttribute('title');
    await pressAndDrag(page, point, leftOfTimeline(page));
    const escapes = await countEscapes(page);
    await page.keyboard.press('Escape');
    expect(await escapes()).toBe(0);
    await page.mouse.up(); await page.waitForTimeout(300);
    await expect(point).toHaveAttribute('title', before!);
    // The Cue point keeps the focus, and the Cue canvas has its own Escape; away from it, Escape stops the show.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    expect(await escapes()).toBe(1);
  } finally { await closeDiscarding(app); }
});

test('灯光工作台拖 Cue 点（还在看得见的范围里）、手还按着时按 Esc：只取消，松手后 Cue 不动', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }], { cueAtMs: 30_000 });
  try {
    const point = await lightingWorkbench(page);
    const before = await left(point);
    await pressAndDrag(page, point, box => Promise.resolve(box.x + box.width / 2 + 80));
    const escapes = await countEscapes(page);
    await page.keyboard.press('Escape');
    expect(await escapes()).toBe(0);
    await page.mouse.up(); await page.waitForTimeout(300);
    expect(await left(point)).toBe(before);
  } finally { await closeDiscarding(app); }
});

test('灯光工作台 Cue 点有焦点时按住 Enter：修改框只开一次，也不会自己保存、改写 Cue', async ({}, info) => {
  // Off the frame grid, so a save would round it and leave something to undo.
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }], { cueAtMs: 30_000.4 });
  try {
    const point = await lightingWorkbench(page);
    await page.evaluate(() => {
      Reflect.set(window, '__dialogs', 0);
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches('dialog.cue-point-dialog')) Reflect.set(window, '__dialogs', Number(Reflect.get(window, '__dialogs')) + 1);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const undo = page.getByRole('button', { name: '撤销', exact: true });
    await expect(undo).toBeDisabled();
    await point.focus();
    await hold(page, 'Enter', 8);
    expect(await page.evaluate(() => Number(Reflect.get(window, '__dialogs')))).toBe(1);
    await expect(page.locator('dialog.cue-point-dialog')).toHaveCount(1);
    await expect(undo).toBeDisabled();
    // A fresh Enter in the time field still saves.
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog.cue-point-dialog')).toHaveCount(0);
    await expect(undo).toBeEnabled();
  } finally { await closeDiscarding(app); }
});

test('灯光工作台正常拖 Cue 点（不按 Esc）：松手后移动生效', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }], { cueAtMs: 30_000 });
  try {
    const point = await lightingWorkbench(page);
    const before = await left(point);
    await pressAndDrag(page, point, box => Promise.resolve(box.x + box.width / 2 + 80));
    await page.mouse.up(); await page.waitForTimeout(400);
    expect(await left(point)).toBeGreaterThan(before + 40);
  } finally { await closeDiscarding(app); }
});

/** Drags the first visual track's name onto the lower part of the second and lets go, pressing Escape halfway when `escape`. */
async function reorderLayers(page: Page, escape: boolean): Promise<{ before: string; after: string }> {
  const headings = page.locator('.visual-layer-heading');
  await expect(headings).toHaveCount(2);
  const lane = page.locator('[data-visual-layer-id="layer-1"]');
  const order = (): Promise<string> => lane.evaluate(element => (element as HTMLElement).style.order);
  const before = await order();
  const from = (await headings.nth(0).locator('.layer-name').boundingBox())!;
  const to = (await headings.nth(1).boundingBox())!;
  await page.mouse.move(from.x + 4, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + to.height * 0.75, { steps: 8 });
  if (escape) await page.keyboard.press('Escape');
  await page.mouse.up(); await page.waitForTimeout(400);
  return { before, after: await order() };
}

test('编辑器拖图层排序到一半按 Esc：Esc 不往下传，松手后排序不变；不按 Esc 时排序生效', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, layers: true }]);
  try {
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const escapes = await countEscapes(page);
    const cancelled = await reorderLayers(page, true);
    expect(await escapes()).toBe(0);
    expect(cancelled.after).toBe(cancelled.before);
    const moved = await reorderLayers(page, false);
    expect(moved.after).not.toBe(moved.before);
  } finally { await closeDiscarding(app); }
});

test('编辑器正常拖机位片段（不按 Esc）：松手后时间移动生效', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, layers: true }]);
  try {
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const clip = page.locator('[data-visual-layer-id="layer-1"] .timeline-cue').first();
    await expect(clip).toBeVisible();
    const box = (await clip.boundingBox())!;
    const before = await left(clip);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up(); await page.waitForTimeout(400);
    expect(await left(page.locator('[data-visual-layer-id="layer-1"] .timeline-cue').first())).toBeGreaterThan(before + 60);
  } finally { await closeDiscarding(app); }
});

test('首页「MTC 时间码状态」开着、点了对话框里的文字（焦点落在对话框上）：Esc 只关对话框，不停节目；开了方向键换歌时 ↓ 不换歌', async ({}, info) => {
  const { app, page } = await open(info, threeSongs, { arrowKeys: true });
  try {
    const transport = await recordTransport(app);
    await mtcStatus(page);
    await page.locator('dialog.ui-dialog[open] h2').click();
    expect(await page.evaluate(() => document.activeElement?.matches('dialog.ui-dialog') === true)).toBe(true);
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(400);
    await expect(page.locator('dialog.ui-dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await transport.asked()).toEqual([]);
    // The dialog closed, the same keys reach the show again.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape'); await page.keyboard.press('ArrowDown');
    await expect.poll(transport.asked).toEqual(['stop', 'skip']);
  } finally { await closeDiscarding(app); }
});

test('首页「MTC 时间码状态」开着：Shift+Esc 在对话框里也停止节目，对话框不关；关掉「单按 Esc 停止」后单按 Esc 不停（00-order 第 8 节第 1 题，K7）', async ({}, info) => {
  const { app, page } = await open(info, threeSongs, { arrowKeys: true });
  try {
    const transport = await recordTransport(app);
    await mtcStatus(page);
    await page.locator('dialog.ui-dialog[open] h2').click();
    await page.keyboard.press('Shift+Escape');
    await expect.poll(transport.asked).toEqual(['stop']);
    await expect(page.locator('dialog.ui-dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    // 「单按 Esc 停止」 off on this computer: Escape on the page no longer stops, Shift+Escape does.
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置子菜单' }).getByRole('button', { name: '播放', exact: true }).click();
    await page.getByRole('button', { name: '快捷键', exact: true }).click();
    await page.getByRole('switch', { name: '单按 Esc 停止' }).click();
    await page.keyboard.press('Escape');
    await transport.clear();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    expect(await transport.asked()).toEqual([]);
    await page.keyboard.press('Shift+Escape');
    await expect.poll(transport.asked).toEqual(['stop']);
  } finally { await closeDiscarding(app); }
});

test('首页「MTC 时间码状态」开着、焦点掉到了页面上（有焦点的按钮被移除或变灰）：空格、↓、歌曲快捷键都不碰节目，Esc 只关对话框', async ({}, info) => {
  const { app, page } = await open(info, threeSongs, { arrowKeys: true });
  try {
    const transport = await recordTransport(app);
    await mtcStatus(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    for (const key of ['Space', 'ArrowDown', 'Control+Digit3']) await page.keyboard.press(key);
    await page.waitForTimeout(600);
    await expect(page.locator('dialog.ui-dialog[open]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await transport.asked()).toEqual([]);
  } finally { await closeDiscarding(app); }
});

test('灯光工作台（联动台播放）「修改 Cue 卡点」开着：焦点在「取消」上、或点了对话框标题后按 Esc，只关对话框，播放头不动、节目不停', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, lighting: true }], { cueAtMs: 30_000 });
  try {
    const point = await lightingWorkbench(page);
    const transport = await recordTransport(app);
    await page.locator('.reference-timeline').focus(); await page.keyboard.press('End'); await page.waitForTimeout(300);
    const timecode = page.locator('code[title="当前播放头时间码"]');
    const end = await timecode.textContent();
    await transport.clear();
    const focusings: Array<() => Promise<void>> = [() => page.keyboard.press('Tab'), () => page.locator('dialog.cue-point-dialog[open] h3').click()];
    for (const focus of focusings) {
      await point.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('dialog.cue-point-dialog[open]')).toHaveCount(1);
      await focus();
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog.cue-point-dialog')).toHaveCount(0);
      await expect(timecode).toHaveText(end!);
    }
    await page.waitForTimeout(400);
    expect(await transport.asked()).toEqual([]);
  } finally { await closeDiscarding(app); }
});

test('编辑器拖机位片段、手还按着时连按两下 Esc：两下都只取消，不停节目；松手后片段不动，之后第一下 Esc 照常停节目', async ({}, info) => {
  const { app, page } = await open(info, [{ id: 'song-a', title: '第一首', audio: true, layers: true }]);
  try {
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
    const clip = page.locator('[data-visual-layer-id="layer-1"] .timeline-cue').first();
    await expect(clip).toBeVisible();
    const transport = await recordTransport(app);
    const box = (await clip.boundingBox())!;
    const before = await left(clip);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 10 });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
    expect(await transport.asked()).toEqual([]);
    await page.mouse.up(); await page.waitForTimeout(400);
    expect(await left(page.locator('[data-visual-layer-id="layer-1"] .timeline-cue').first())).toBe(before);
    await page.keyboard.press('Escape');
    await expect.poll(transport.asked).toEqual(['stop']);
  } finally { await closeDiscarding(app); }
});
