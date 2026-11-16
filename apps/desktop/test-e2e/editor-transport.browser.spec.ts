import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let script = '';
let styles = '';
test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import './src/renderer/src/styles/layers.css';
      import './src/renderer/src/styles/tokens.css';
      import './src/renderer/src/link/ui/ui.css';
      import { createRoot } from 'react-dom/client';
      import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
      import { emptyInternalPlayerState, reconcileMa2ReadState, setItemPlaybackCommand } from '@tb/core/link';
      import { useDocumentStore } from './src/renderer/src/link/stores/document-store';
      import { useEditorTransport } from './src/renderer/src/link/components/useEditorTransport';
      import { useLightingDocument } from './src/renderer/src/link/components/useCueWorkspaceSetup';
      import { LightingLanes } from './src/renderer/src/link/components/LightingTimeline';
      import { Ma2CachedBrowser } from './src/renderer/src/link/components/Ma2CachedBrowser';
      import { useSelectedProgram } from './src/renderer/src/link/useSelectedProgram';
      import { Ma2PendingChanges } from './src/renderer/src/link/components/Ma2PendingChanges';
      import { ma2SongSyncSettings } from './src/renderer/src/link/runtime/ma2-song-sync';
      import { useMa2RealtimePreference } from './src/renderer/src/link/runtime/ma2-realtime-preference';
      import { linkDesktopViewModel } from './src/renderer/src/link/view-models/link-desktop-view-model';
      import { useMa2ReadStore } from './src/renderer/src/link/stores/ma2-read-store';
      import { useMa2SyncStore } from './src/renderer/src/link/stores/ma2-sync-store';
      const project = parseLinkProject({ ...createEmptyLinkProject('只有音乐和灯光'), playbackSource: 'internal',
        rundown: [{ id: 'song', title: '歌曲', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 } }] });
      const lighting = createLightingDocument();
      lighting.tracks = [lightingTrackSchema.parse({ id: 'track', kind: 'ma2', name: '序列 7', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
        clips: [{ id: 'clip', name: '控台灯光', start: 0, duration: 5000, timeLock: 'time', muted: false,
        events: [{ id: 'cue', kind: 'ma2', at: 1000, sequence: 7, cue: '1', executor: '1.101', label: '控台第一步', action: 'goto' }] }] })];
      const preview = { target: 7, name: '控台歌曲', readAt: '2026-11-14T00:00:00.000Z', document: lighting, sourceXml: '<MA><Timecode index="7"/></MA>', timeOriginMs: 60000,
        mappings: [{ eventId: 'cue', trackId: 'track', clipId: 'clip', path: 'Timecode:7/Track:0/SubTrack:0/Event:0', sequence: 7, cueIndex: 1, executor: '1.101' }], warnings: [], unconverted: [] };
      const catalog = { directory: { show: 'show', generation: '1', version: '3.3.4', entries: [{ target: 7, name: '控台歌曲' }] }, readAt: preview.readAt,
        entries: [{ target: 7, name: '控台歌曲', eventCount: 1, frameFormat: '30 FPS', slot: 'TC Slot 2', offset: '1800', events: [{ path: '0', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: null }], error: null, warnings: [], preview }] };
      project.schemaVersion = 2; project.ma2ReadState = reconcileMa2ReadState(project, 'console', catalog);
      project.rundown.push({ ...project.rundown[0], id: 'second', title: '第二首歌' });
      useDocumentStore.setState({ project, path: 'C:/show/project.tblink' });
      localStorage.setItem('tblink.ma2-connection-method.v1', 'network');
      useMa2RealtimePreference.setState({ enabled: false, once: null });
      window.timelineSyncState = (state) => {
        useMa2RealtimePreference.setState({ enabled: true });
        useMa2SyncStore.setState({ songs: { song: { sessionId: 'test', itemId: 'song', documentId: 0, name: '歌曲', settings: ma2SongSyncSettings(useDocumentStore.getState().project, 'song'), state, message: state === 'blocked' ? '控台读取失败' : state } } });
      };
      window.syncSummaryFixture = (mode) => {
        const next = structuredClone(useDocumentStore.getState().project);
        const draft = createLightingDocument();
        draft.tracks = structuredClone(lighting.tracks);
        draft.tracks[0].clips[0].events = Array.from({ length: 18 }, (_, index) => ({ id: 'draft-' + index, kind: 'empty-cue', at: index * 100, label: 'Cue ' + index }));
        if (mode === 'planned') { draft.timelineDestination = { name: '新建空时间线', sequence: 9200, timecode: 9200, executor: '1000.108' }; draft.tracks[0].clips[0].events = []; }
        if (mode === 'showless') draft.consoleSong = { endpoint: '192.0.2.1:30000', show: 'Show', sequence: 9200, name: '第二首歌', executor: '1000.108', layout: null, baselineXml: '<MA/>', points: [] };
        next.rundown[1].lighting = draft;
        useDocumentStore.setState({ project: next });
        window.timelineSyncState('verified');
        useMa2SyncStore.setState({ session: { status: 'ready', message: '已连接' } });
        if (mode === 'showless') useMa2SyncStore.setState(state => ({ songs: { ...state.songs, second: { ...state.songs.song, itemId: 'second', name: '第二首歌', state: 'pending', message: '等待创建 Timecode' } } }));
      };
      linkDesktopViewModel.projectArchiveSettings = () => Promise.resolve({ settings: { enabled: true } });
      window.timelineDirectory = () => {
        const next = structuredClone(useDocumentStore.getState().project);
        next.ma2ReadState.catalog.directory.entries.push(...Array.from({ length: 149 }, (_, index) => ({ target: index + 100, name: '其他时间线 ' + index })));
        useDocumentStore.setState({ project: next });
      };
      window.consoleTimeline = preview;
      window.tbLink = { getMa2NetworkStatus: async () => ({ state: 'disconnected' }) };
      window.syncSettings = () => ma2SongSyncSettings(useDocumentStore.getState().project, 'song');
      const calls = [];
      const call = (kind, position) => { calls.push({ kind, position }); return Promise.resolve(); };
      const player = { state: { ...emptyInternalPlayerState }, view: { readClock: () => ({ positionMs: 0 }), subscribeClock: () => () => {} },
        controller: { play: (id, position) => call('play', position), pause: () => call('pause'), resume: () => call('resume'), stop: () => call('stop') } };
      let failPreview;
      const coordinator = { previewEditor: () => new Promise((resolve, reject) => { failPreview = reject; }), cancelEditorPreview: () => {} };
      function Harness() {
        const [error, setError] = useState('');
        const [browserOpen, setBrowserOpen] = useState(false);
        const requestedBrowser = useMa2ReadStore(state => state.browserOpen);
        const [selected] = useSelectedProgram(setError);
        const item = useDocumentStore(state => state.project.rundown.find(item => item.id === selected) ?? state.project.rundown[0]);
        const lights = useLightingDocument(item);
        const transport = useEditorTransport(player, 'song', true, (message, tone) => { if (tone === 'error') setError(message); }, coordinator);
        return <><button onClick={() => transport.setPlayheadMs(2500)}>定位</button>
          <button onClick={() => transport.setPlaying(true)}>播放</button><button onClick={() => transport.setPlaying(false)}>暂停</button>
          <button onClick={transport.stop}>停止</button><button onClick={() => failPreview(new Error('OBS 没有连接'))}>画面失败</button>
          <div role="alert">{error}</div>
          <button onClick={() => useDocumentStore.getState().execute(setItemPlaybackCommand('song', { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 60000, shortcut: '' }))}>修改起始码</button>
          <button onClick={() => useDocumentStore.getState().undo()}>撤销</button>
          <button onClick={() => setBrowserOpen(true)}>控台时间线</button>
          <output aria-label="当前歌曲">{item.title}</output>
          {browserOpen || requestedBrowser ? <Ma2CachedBrowser disabled={false} notify={setError} onClose={() => setBrowserOpen(false)} /> : null}
          <Ma2PendingChanges notify={setError} />
          <LightingLanes document={lights} selectedClipId={null} onSelect={() => {}} onChange={() => {}} pixelsPerSecond={100} scrollLeft={0} viewportWidth={1000}
            playhead={transport.playhead} onSeek={transport.setPlayheadMs} timeAtClientX={x => x * 10} /></>;
      }
      window.transportCalls = () => calls;
      createRoot(document.getElementById('root')).render(<Harness />);
    ` },
    bundle: true, write: false, outfile: 'editor-test.js', platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'import.meta.hot': 'undefined', 'import.meta.url': JSON.stringify('http://127.0.0.1/editor-test') },
    alias: { '@tb/schema': resolve('../../packages/schema/src/index.ts'), '@tb/core/link': resolve('../../packages/core/src/link-public.ts') }
  });
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  styles = result.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});

test('首次改起始码配对：灯光时间线立即显示控台 Cue，撤销同时移除', async ({ page }) => {
  const cue = page.getByRole('button', { name: '灯光点 控台第一步', exact: true });
  await expect(cue).toHaveCount(0);
  await page.getByRole('button', { name: '修改起始码', exact: true }).click();
  await expect(cue).toBeVisible();
  await expect(cue).toHaveAttribute('title', /1\.000 秒/);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(cue).toHaveCount(0);
});

test('控台同步旁选择新歌位置：保存后所有同步入口使用同一页与起始编号', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '写入位置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '控台写入位置' });
  await dialog.getByLabel('默认创建按钮页').fill('2000');
  await dialog.getByLabel('起始序列编号').fill('8000');
  await dialog.getByRole('button', { name: '保存默认', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('按钮第 2000 页');
  expect(await page.evaluate('window.syncSettings()')).toMatchObject({ executorPage: 2000, nextSequence: 8000 });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '写入位置', exact: true }).click();
  await expect(dialog.getByLabel('默认创建按钮页')).toHaveValue('2000');
  await expect(dialog.getByLabel('起始序列编号')).toHaveValue('8000');
  await page.screenshot({ path: testInfo.outputPath('lighting-destination.png') });
});

test('点击同步一次：缺少控台素材时直接说明原因，不一直假装正在同步', async ({ page }) => {
  await page.getByRole('button', { name: '同步一次', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '同步状态详情' })).toContainText('请先读取控台素材，再同步到控台');
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.route('http://127.0.0.1/editor-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1/editor-test');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
});

test('编辑器定位期间按播放：OBS 失败仍按所选位置播放，并保留画面错误提示', async ({ page }) => {
  await page.getByRole('button', { name: '定位', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: '画面失败', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('OBS 没有连接');
  await expect.poll(() => page.evaluate('window.transportCalls()')).toEqual([{ kind: 'play', position: 2500 }]);
});

for (const action of ['暂停', '停止']) test(`定位期间按播放后再${action}：OBS 迟到的失败不能启动歌曲`, async ({ page }) => {
  await page.getByRole('button', { name: '定位', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.getByRole('button', { name: '画面失败', exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(await page.evaluate('window.transportCalls()')).toEqual(action === '停止' ? [{ kind: 'stop' }] : []);
});


test('时间线列表默认选中当前匹配；新建空时间线立即显示并可进入编辑', async ({ page }, info) => {
  await page.setViewportSize({ width: 1260, height: 800 });
  await page.addStyleTag({ content: 'body { margin: 0; background: #08080a; color: #e8e9ec; font-family: "Microsoft YaHei", sans-serif; } .ma2-cached-browser { box-sizing: border-box; height: auto; min-height: 400px; }' });
  await page.getByRole('button', { name: '修改起始码', exact: true }).click();
  await page.evaluate('window.timelineDirectory()');
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  const browser = page.getByRole('region', { name: '控台时间线与歌曲', exact: true });
  await expect(browser.getByRole('status', { name: '时间线状态', exact: true })).toContainText('已匹配当前节目');
  await expect(browser.getByRole('option')).toHaveCount(1);
  await browser.getByRole('button', { name: '全部时间线（150）', exact: true }).click();
  await expect(browser.getByRole('option')).toHaveCount(150);
  await browser.getByRole('button', { name: '返回当前节目', exact: true }).click();
  await expect(browser.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '灯光点 控台第一步', exact: true })).toBeVisible();
  await expect(browser.getByRole('option', { name: 'Timecode 7 · 控台歌曲', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(browser.getByRole('button', { name: '重新读取 Cue', exact: true })).toBeEnabled();
  await expect(browser.getByRole('button', { name: /读入|追加|替换/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('timeline-auto-match.png'), fullPage: true });
  await browser.getByRole('button', { name: '编辑 Cue', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  await browser.getByRole('button', { name: '新建时间线', exact: true }).click();
  await page.getByRole('dialog', { name: '新建时间线', exact: true }).getByLabel('时间线名称', { exact: true }).fill('新编排');
  await page.getByRole('dialog', { name: '新建时间线', exact: true }).getByLabel('MTC 起始码', { exact: true }).fill('00:03:00:00');
  await page.getByRole('dialog', { name: '新建时间线', exact: true }).getByLabel('Timecode 编号', { exact: true }).fill('9100');
  await page.getByRole('dialog', { name: '新建时间线', exact: true }).getByLabel('多步 Cue 序列编号', { exact: true }).fill('9200');
  await page.getByRole('dialog', { name: '新建时间线', exact: true }).getByLabel('执行器位置（页.格）', { exact: true }).fill('1000.108');
  await page.screenshot({ path: info.outputPath('timeline-new.png'), fullPage: true });
  await page.setViewportSize({ width: 760, height: 800 });
  expect(await browser.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('dialog', { name: '新建时间线', exact: true }).getByRole('button', { name: '新建时间线', exact: true }).click();
  await expect(browser.getByRole('heading', { name: '新编排', exact: true })).toBeVisible();
  await expect(browser.getByRole('option', { name: 'Timecode 9100 · 新编排', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(browser).toContainText('等待控台创建');
  await expect(browser.getByRole('button', { name: '同步当前时间线', exact: true })).toBeEnabled();
  await expect(browser).toContainText('Timecode 9100');
  await expect(browser).toContainText('序列 9200 · 执行器 1000.108');
  await expect(browser).toContainText('00:03:00:00');
});


test('列表手动关联：对齐起始码并显示 Cue，保持本页且可撤销', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addStyleTag({ content: 'body { margin: 0; background: #08080a; color: #e8e9ec; font-family: "Microsoft YaHei", sans-serif; } .ma2-cached-browser { box-sizing: border-box; height: auto; }' });
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  const browser = page.getByRole('region', { name: '控台时间线与歌曲', exact: true });
  await expect(browser.getByRole('option')).toHaveCount(0);
  await browser.getByRole('button', { name: '关联已有时间线', exact: true }).click();
  await expect(browser.getByRole('option')).toHaveCount(1);
  await browser.getByRole('option', { name: 'Timecode 7 · 控台歌曲', exact: true }).click();
  await expect(browser).toContainText('MTC 00:01:00:00');
  await browser.getByRole('button', { name: '用于当前节目', exact: true }).click();
  await expect(browser.getByRole('status', { name: '时间线状态', exact: true })).toContainText('已匹配当前节目');
  await expect(browser.getByRole('option', { name: 'Timecode 7 · 控台歌曲', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(browser.getByRole('button', { name: '重新读取 Cue', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '灯光点 控台第一步', exact: true })).toBeVisible();
  const status = browser.getByRole('status', { name: '时间线状态', exact: true });
  await expect(status).toContainText('已匹配当前节目');
  await expect(status).toContainText('同步暂停');
  await page.evaluate('window.timelineSyncState("verified")');
  await expect(status).toContainText('已同步');
  await page.screenshot({ path: info.outputPath('timeline-manual-sync.png'), fullPage: true });
  for (const [state, label] of [['pending', '待同步'], ['syncing', '同步中'], ['blocked', '同步失败'], ['paused', '同步暂停']]) {
    await page.evaluate(value => (window as unknown as { timelineSyncState: (state: string) => void }).timelineSyncState(value!), state);
    await expect(status).toContainText('已匹配当前节目');
    await expect(status).toContainText(label!);
  }
  await page.setViewportSize({ width: 640, height: 720 });
  expect(await browser.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(browser).toContainText('当前节目尚未关联时间线');
  await expect(browser.getByRole('option')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '灯光点 控台第一步', exact: true })).toHaveCount(0);
});


test('手动匹配现读控台，不再只用旧缓存的 Cue', async ({ page }) => {
  await page.evaluate(() => {
    const host = window as unknown as { consoleTimeline: Record<string, unknown>; tbLink: Record<string, unknown> };
    host.tbLink.getMa2NetworkStatus = () => Promise.resolve({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' } });
    host.tbLink.previewMa2 = () => {
      const read = structuredClone(host.consoleTimeline) as unknown as { document: { tracks: { clips: { events: { at: number; label: string }[] }[] }[] } };
      read.document.tracks[0]!.clips[0]!.events[0]!.at = 2500;
      read.document.tracks[0]!.clips[0]!.events[0]!.label = '刚从控台读取的 Cue';
      return Promise.resolve(read);
    };
  });
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  const browser = page.getByRole('region', { name: '控台时间线与歌曲', exact: true });
  await browser.getByRole('button', { name: '关联已有时间线', exact: true }).click();
  await browser.getByRole('option', { name: 'Timecode 7 · 控台歌曲', exact: true }).click();
  await browser.getByRole('button', { name: '用于当前节目', exact: true }).click();
  await expect(page.getByRole('button', { name: '灯光点 刚从控台读取的 Cue', exact: true })).toHaveAttribute('title', /2\.500 秒/);
  await expect(page.getByRole('button', { name: '灯光点 控台第一步', exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert').first()).toContainText('载入 1 个 Cue（刚从控台读取）');
});


test('新建时间线右键修改名称和 MTC，Cue 编辑仍进入原编辑器', async ({ page }) => {
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  const browser = page.getByRole('region', { name: '控台时间线与歌曲', exact: true });
  await browser.getByRole('button', { name: '新建时间线', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建时间线', exact: true });
  await dialog.getByLabel('时间线名称', { exact: true }).fill('新编排');
  await dialog.getByLabel('MTC 起始码', { exact: true }).fill('00:03:00:00');
  await dialog.getByRole('button', { name: '新建时间线', exact: true }).click();
  await browser.getByRole('option', { name: /新编排/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改名称 / MTC', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '修改时间线', exact: true });
  await edit.getByLabel('时间线名称', { exact: true }).fill('修改后的灯光');
  await edit.getByLabel('MTC 起始码', { exact: true }).fill('00:04:00:00');
  await edit.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(browser.getByRole('option', { name: /修改后的灯光/ })).toContainText('00:04:00:00');
  await browser.getByRole('button', { name: '编辑 Cue', exact: true }).click();
  await expect(browser).toHaveCount(0);
});


test('当前节目已同步时，其他未关联草稿显示待关联，不再假报待同步', async ({ page }, info) => {
  await page.getByRole('button', { name: '修改起始码', exact: true }).click();
  await page.evaluate('window.syncSummaryFixture("unlinked")');
  const status = page.getByRole('button', { name: '同步状态详情', exact: true });
  await expect(status).toHaveText('已同步');
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  await expect(page.getByRole('status', { name: '时间线状态', exact: true })).toContainText('已同步');
  await status.click();
  const details = page.getByRole('dialog', { name: '同步状态详情', exact: true });
  await expect(details).toContainText('全工程 · 已同步');
  await expect(details).toContainText('当前节目 · 歌曲');
  await expect(details).toContainText('第二首歌 · 18 个 Cue · 尚未关联时间线');
  await expect(details).not.toContainText('按钮第 1000 页的空格');
  await page.screenshot({ path: info.outputPath('sync-summary-unlinked.png') });
  await details.getByRole('button', { name: '为「第二首歌」选择时间线', exact: true }).click();
  await expect(page.getByRole('status', { name: '时间线状态', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('当前歌曲', { exact: true })).toHaveText('第二首歌');
  await expect(page.getByRole('region', { name: '控台时间线与歌曲', exact: true })).toBeVisible();
});

for (const mode of ['planned', 'showless']) test(`真实等待创建的节目仍计入待同步且只计一次：${mode}`, async ({ page }) => {
  await page.getByRole('button', { name: '修改起始码', exact: true }).click();
  await page.evaluate(value => (window as unknown as { syncSummaryFixture: (value: string) => void }).syncSummaryFixture(value), mode);
  await expect(page.getByRole('button', { name: '同步状态详情', exact: true })).toHaveText('待同步 1');
});
