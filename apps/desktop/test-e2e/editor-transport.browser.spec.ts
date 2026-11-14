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
          {browserOpen ? <Ma2CachedBrowser disabled={false} notify={setError} onClose={() => setBrowserOpen(false)} /> : null}
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

test('用这条时间线：选择另一首歌后切到该歌曲并显示导入的 Cue', async ({ page }) => {
  await page.getByRole('button', { name: '控台时间线', exact: true }).click();
  await page.getByRole('combobox', { name: 'Timecode 7 给哪首歌用' }).selectOption('second');
  await page.getByRole('button', { name: '用这条时间线', exact: true }).click();
  await expect(page.getByLabel('当前歌曲')).toHaveText('第二首歌');
  await expect(page.getByRole('button', { name: '灯光点 控台第一步', exact: true })).toBeVisible();
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
