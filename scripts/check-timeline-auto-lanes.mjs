import { chromium, expect } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('**/__auto-lanes', route => route.fulfill({ contentType: 'text/html', body: '<div id="test"></div>' }));
  await page.goto('http://localhost:5173/__auto-lanes');
  await page.evaluate(async () => {
    const refresh = await import('/@react-refresh'); refresh.injectIntoGlobalHook(globalThis); globalThis.$RefreshReg$ = () => {}; globalThis.$RefreshSig$ = () => type => type;
    const source = await (await fetch('/src/main.tsx')).text();
    const { default: React } = await import(source.match(/from "([^"]*deps\/react\.js[^"]*)"/)[1]);
    const { default: { createRoot } } = await import(source.match(/from "([^"]*deps\/react-dom_client.js[^"]*)"/)[1]);
    await import('/src/link/link.css'); await import('/src/link/appearance.css'); await import('/src/link/timeline-editing.css');
    const { ReferenceTimeline } = await import('/src/link/components/ReferenceTimeline.tsx');
    const { MEDIA_DRAG_TYPE, OBS_DRAG_TYPE } = await import('/src/link/components/ResourceLibrary.tsx');
    globalThis.dragTypes = { media: MEDIA_DRAG_TYPE, obs: OBS_DRAG_TYPE };
    const clip = { id: 'video', assetId: 'asset', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, durationMs: 2000, layerId: 'one' };
    const cue = { id: 'cue', name: '机位', timecode: clip.startTimecode, durationMs: 2000, layerId: 'two', actions: [{ id: 'action', kind: 'obs.setProgramScene', sceneName: 'Camera' }] };
    const layers = ['empty', 'one', 'two'].map(id => ({ id, name: id, locked: false, visible: true }));
    globalThis.calls = [];
    function Harness() {
      const [state, setState] = React.useState({ clips: [clip], cues: [cue], layers });
      const move = (kind, id, ms, layerId) => {
        globalThis.calls.push([kind, id, ms, layerId]);
        setState(current => {
          const layer = layerId === null ? { id: `new-${globalThis.calls.length}`, name: '新轨道', visible: true, locked: false } : null;
          return { ...current, layers: layer ? [...current.layers, layer] : current.layers,
            [kind === 'clip' ? 'clips' : 'cues']: current[kind === 'clip' ? 'clips' : 'cues'].map(entry => entry.id === id ? { ...entry, layerId: layer?.id ?? layerId } : entry) };
        });
      };
      const [selectedClipId, setSelectedClipId] = React.useState(null);
      const noop = () => {};
      return React.createElement(ReferenceTimeline, {
        ...state, assets: [{ id: 'asset', kind: 'video' }], projectPath: null, frameRate: '30', durationMs: 10000, playheadMs: 0, referenceAudio: null, playing: false, selectedCueId: null,
        timelineState: { itemId: 'song', clips: state.clips.map(clip => ({ clip, startMs: 1000, endMs: 3000, durationMs: 2000 })), visualObsCues: [], activeClipIds: [], activeObsCueIds: [] },
        ...Object.fromEntries(['onPlayheadChange', 'onPlayingChange', 'onPlaybackError', 'onSelectClip', 'onSelectCue', 'onTrimClip', 'onTrimCue', 'onSetClipEmbeddedAudioEnabled', 'onSplitClip', 'onDuplicateClip', 'onDuplicateCue', 'onAddLayer', 'onMoveLayer', 'onUpdateLayer', 'onDeleteLayer', 'onDeleteCue'].map(name => [name, noop])),
        selectedClipId, onSelectClip: setSelectedClipId,
        onDeleteClip: id => setState(current => ({ ...current, clips: current.clips.filter(clip => clip.id !== id) })),
        onMoveClip: (...args) => move('clip', ...args), onMoveCue: (...args) => move('cue', ...args),
        onDropAsset: (...args) => globalThis.calls.push(['asset', ...args]), onDropObsResource: (...args) => globalThis.calls.push(['obs', ...args])
      });
    }
    createRoot(document.getElementById('test')).render(React.createElement(Harness));
  });
  await expect(page.locator('.visual-layer-heading')).toHaveCount(2);
  const bottom = page.locator('[data-new-visual-layer]');
  async function dragToBottom(selector, cancel = false) {
    const source = await page.locator(selector).boundingBox(); const target = await bottom.boundingBox();
    await page.mouse.move(source.x + 30, source.y + 20); await page.mouse.down();
    await page.mouse.move(target.x + 180, target.y + 35, { steps: 8 });
    await expect(bottom).toHaveClass(/is-drop-target/);
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  await dragToBottom('.timeline-clip', true);
  expect(await page.evaluate(() => globalThis.calls)).toEqual([]);
  await dragToBottom('.timeline-clip');
  await expect(page.locator('[data-visual-layer-id="one"]')).toHaveCount(0);
  await expect(page.locator('.visual-layer-heading')).toHaveCount(2);
  await dragToBottom('.timeline-cue');
  await expect(page.locator('[data-visual-layer-id="two"]')).toHaveCount(0);
  expect((await page.evaluate(() => globalThis.calls)).map(call => [call[0], call[3]])).toEqual([['clip', null], ['cue', null]]);
  for (const [selector, expected] of [['[data-visual-layer-id="new-1"]', 'new-1'], ['[data-new-visual-layer]', null]]) {
    await page.locator(selector).evaluate((element) => {
      const transfer = new DataTransfer(); transfer.setData(globalThis.dragTypes.media, 'asset');
      const rect = element.getBoundingClientRect(); element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer, clientX: rect.x + 100, clientY: rect.y + 20 }));
    });
    expect((await page.evaluate(() => globalThis.calls.at(-1)))[3]).toBe(expected);
  }
  await page.locator('.timeline-clip').click(); await page.keyboard.press('Delete');
  await expect(page.locator('.visual-layer-heading')).toHaveCount(1);
  await mkdir('acceptance-20260914-auto-lanes', { recursive: true });
  await page.screenshot({ path: 'acceptance-20260914-auto-lanes/timeline.png' });
  expect(errors).toEqual([]);
  console.log('通过：隐藏空轨道、视频/场景下拖新建、Escape 取消、删除后收起、素材库落点。');
} finally { await browser.close(); }
