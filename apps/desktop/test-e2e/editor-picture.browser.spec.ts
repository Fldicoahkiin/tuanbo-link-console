import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let script: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
    import { SceneOutputTimeline, TimelineStateIndex, emptyInternalPlayerState } from '@tb/core/link';
    import { ContentTracks, contentEditRules } from './src/renderer/src/link/components/ContentTracks';
    import { TimelineScroll } from './src/renderer/src/link/components/timeline-scroll';
    import { useEditorTransport } from './src/renderer/src/link/components/useEditorTransport';
    import { useDocumentStore } from './src/renderer/src/link/stores/document-store';
    import { useIntegrationStore } from './src/renderer/src/link/stores/integration-store';
    import { useShowStateStore } from './src/renderer/src/link/stores/show-state-store';
    import { LinkRuntimeCoordinator } from './src/renderer/src/link/runtime/link-runtime-coordinator';
    import { linkDesktopViewModel } from './src/renderer/src/link/view-models/link-desktop-view-model';
    const project = parseLinkProject({ ...createEmptyLinkProject('点击场景'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '节目', referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
        visualLayers: [{ id: 'cameras', name: '机位' }], cues: [2, 5].map((seconds, index) => ({
          id: 'camera-' + index, name: '场景 ' + index, layerId: 'cameras', durationMs: 2000,
          timecode: { hours: 0, minutes: 0, seconds, frames: 0 },
          actions: [{ id: 'scene-' + index, label: '切场景', kind: 'obs.setProgramScene', sceneName: 'Camera ' + index }]
        })) }] });
    useDocumentStore.setState({ project, path: null });
    useIntegrationStore.setState(state => ({ obs: { ...state.obs, status: 'connected' } }));
    const calls = [], edits = [];
    linkDesktopViewModel.executeObsAction = async action => { calls.push({ kind: 'scene', scene: action.sceneName }); };
    linkDesktopViewModel.recordLog = async () => {};
    const coordinator = new LinkRuntimeCoordinator(project, null);
    const scroll = new TimelineScroll();
    const item = project.rundown[0];
    let clock = 0;
    const listeners = new Set();
    const view = { readClock: () => ({ positionMs: clock }), subscribeClock: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
    const controller = { scrub: async (id, position) => { calls.push({ kind: 'scrub', position }); clock = position; for (const listener of listeners) listener(); },
      resume: async () => { calls.push({ kind: 'resume' }); }, play: async () => { calls.push({ kind: 'play' }); }, pause: async () => {}, stop: async () => {} };
    window.pictureCalls = () => calls;
    window.pictureEdits = () => edits;
    function Harness() {
      const [selected, select] = useState(null), [error, report] = useState(''), [status, setStatus] = useState('stopped');
      const [locked, lock] = useState(false);
      const [internal, setInternal] = useState(true);
      const transport = useEditorTransport({ state: { ...emptyInternalPlayerState, status, itemId: status === 'stopped' ? null : 'song' }, view, controller }, 'song', internal, report, coordinator);
      window.picturePosition = () => transport.playhead.read();
      return <><button onClick={() => setStatus('paused')}>暂停状态</button><button onClick={() => setStatus('playing')}>播放状态</button><button onClick={() => lock(true)}>锁定轨道</button>
        <button onClick={() => setInternal(false)}>P1 工程</button>
        <button onClick={() => useShowStateStore.setState({ show: { phase: 'running', source: 'p1', itemId: 'song', program: null } })}>P1 正在跟随</button>
        <div role="alert">{error}</div><div className="tracks">
        <ContentTracks layers={item.visualLayers.map(layer => ({ ...layer, locked }))} clips={[]} cues={item.cues} assets={new Map()} frameRate="30" durationMs={10000}
          playhead={transport.playhead} timelineState={new TimelineStateIndex(project, item).at(0)} airtime={new SceneOutputTimeline(project, 'song').airtime()}
          onAirtime={null} pending={new Set()} pendingMark={{ text: '', title: '' }} selectedClipId={null} selectedCueId={selected} beatSnapPoints={[]} markerSnapPoints={[]}
          playing={transport.playing} rules={contentEditRules(project, 'song')} viewport={{ viewportRef: { current: document.querySelector('.tracks') }, pixelsPerSecond: 100, scroll,
            view: { left: 0, top: 0, width: 1000, height: 100 }, timeAtClientX: x => (x - document.querySelector('.tracks').getBoundingClientRect().left) * 10,
            scrollLeftTo: () => {}, maxScrollLeft: () => 0 }} tracks={{ start: 0, lightingIndex: 1, lightingHeight: 0, coveredTop: 0 }} snap={{ enabled: false, thresholdMs: 0 }}
          lanePointer={{}} focusTimeline={() => {}} onOpenMenu={() => {}} onSelectCue={select} onSelectClip={() => {}} onSeek={transport.setPlayheadMs}
          onMoveClip={() => {}} onMoveCue={(...args) => edits.push(['move', ...args])} onTrim={(...args) => edits.push(['trim', ...args])} onDropAsset={() => {}} onDropObsResource={() => {}} />
        </div></>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  ` }, bundle: true, write: false, outfile: 'picture-test.js', platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'import.meta.hot': 'undefined', 'import.meta.url': JSON.stringify('http://127.0.0.1/picture-test') },
    alias: { '@tb/schema': resolve('../../packages/schema/src/index.ts'), '@tb/core/link': resolve('../../packages/core/src/link-public.ts') } });
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.route('http://127.0.0.1/picture-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1/picture-test');
  await page.addStyleTag({ content: '.tracks { position:relative; width:1000px; height:100px; } .timeline-lane { position:relative; height:64px; } .timeline-cue { position:absolute; top:0; height:60px; border:0; padding:0; } [data-edge] { position:absolute; top:0; bottom:0; width:8px; } [data-edge="start"] { left:0; } [data-edge="end"] { right:0; }' });
  await page.addScriptTag({ content: script });
});

test('未播放、未保存：点击场景立即定位，连续点击同一位置仍能重新触发', async ({ page }) => {
  const first = page.locator('[data-id="camera-0"]');
  await first.click({ position: { x: 60, y: 25 } });
  await expect.poll(() => page.evaluate('window.pictureCalls()')).toEqual([{ kind: 'scene', scene: 'Camera 0' }]);
  expect(await page.evaluate('window.picturePosition()')).toBeCloseTo(2600, -1);
  await page.locator('[data-id="camera-1"]').click({ position: { x: 60, y: 25 } });
  await first.click({ position: { x: 60, y: 25 } });
  await first.click({ position: { x: 60, y: 25 } });
  await expect.poll(() => page.evaluate('window.pictureCalls()')).toEqual(['Camera 0', 'Camera 1', 'Camera 0', 'Camera 0'].map(scene => ({ kind: 'scene', scene })));
  expect(await page.evaluate('window.pictureEdits()')).toEqual([]);
  await expect(page.getByRole('alert')).toBeEmpty();
});

for (const mode of ['暂停', '播放']) test(`${mode}时点击场景交给同一播放器定位`, async ({ page }) => {
  await page.getByRole('button', { name: `${mode}状态` }).click();
  await page.locator('[data-id="camera-1"]').click({ position: { x: 60, y: 25 } });
  await expect.poll(() => page.evaluate('window.pictureCalls().map(call => call.kind)')).toEqual(mode === '播放' ? ['scrub', 'resume'] : ['scrub']);
  expect(await page.evaluate('window.pictureCalls()[0].position')).toBeCloseTo(5600, -1);
  await expect(page.getByRole('alert')).toBeEmpty();
});

test('移动和修剪只编辑，不误切画面；右键菜单也不触发定位', async ({ page }) => {
  const cue = page.locator('[data-id="camera-0"]');
  const box = await cue.boundingBox(); if (!box) throw new Error('没有场景片段');
  await page.mouse.move(box.x + 60, box.y + 25); await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 25, { steps: 4 }); await page.mouse.up();
  await expect.poll(() => page.evaluate('window.pictureEdits().map(edit => edit[0])')).toEqual(['move']);
  const edge = await cue.locator('[data-edge="end"]').boundingBox(); if (!edge) throw new Error('没有修剪手柄');
  await page.mouse.move(edge.x + 3, edge.y + 25); await page.mouse.down();
  await page.mouse.move(edge.x - 30, edge.y + 25, { steps: 4 }); await page.mouse.up();
  await expect.poll(() => page.evaluate('window.pictureEdits().map(edit => edit[0])')).toEqual(['move', 'trim']);
  await cue.click({ button: 'right', position: { x: 60, y: 25 } });
  expect(await page.evaluate('window.pictureCalls()')).toEqual([]);
});

test('锁定轨道仍可定位；键盘激活定位到片段开头', async ({ page }) => {
  await page.getByRole('button', { name: '锁定轨道' }).click();
  await page.locator('[data-id="camera-1"]').click({ position: { x: 60, y: 25 } });
  await expect.poll(() => page.evaluate('window.pictureCalls()')).toEqual([{ kind: 'scene', scene: 'Camera 1' }]);
  await page.locator('[data-id="camera-0"]').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate('window.pictureCalls()')).toEqual([{ kind: 'scene', scene: 'Camera 1' }, { kind: 'scene', scene: 'Camera 0' }]);
  expect(await page.evaluate('window.picturePosition()')).toBe(2000);
  expect(await page.evaluate('window.pictureEdits()')).toEqual([]);
});

test('P1 工程未播放也能定位；开始跟随后不抢正在输出的画面', async ({ page }) => {
  await page.getByRole('button', { name: 'P1 工程', exact: true }).click();
  await page.locator('[data-id="camera-0"]').click({ position: { x: 60, y: 25 } });
  await expect.poll(() => page.evaluate('window.pictureCalls()')).toEqual([{ kind: 'scene', scene: 'Camera 0' }]);
  await page.getByRole('button', { name: 'P1 正在跟随', exact: true }).click();
  await page.locator('[data-id="camera-1"]').click({ position: { x: 60, y: 25 } });
  await expect(page.getByRole('alert')).toContainText('演出还没停止');
  expect(await page.evaluate('window.pictureCalls()')).toEqual([{ kind: 'scene', scene: 'Camera 0' }]);
});
