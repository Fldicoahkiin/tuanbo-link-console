import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let script: string;
let css: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import './src/renderer/src/styles/layers.css';
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
    import { CommonProperties } from './src/renderer/src/link/components/CommonProperties';
    import { ClipInspector } from './src/renderer/src/link/components/ClipInspector';
    import { CueInspector } from './src/renderer/src/link/components/CueInspector';
    import { AudioInspector } from './src/renderer/src/link/components/AudioInspector';
    import { useAudioEditor } from './src/renderer/src/link/components/useAudioEditor';
    import { EditorPlayhead } from './src/renderer/src/link/components/editor-playhead';
    import { LightingTimelineInspector } from './src/renderer/src/link/components/LightingTimelineInspector';
    import { useDocumentStore } from './src/renderer/src/link/stores/document-store';
    import './src/renderer/src/styles/tokens.css';
    import './src/renderer/src/link/ui/ui.css';
    import './src/renderer/src/link/link.css';
    import './src/renderer/src/link/project-workspace.css';
    import './src/renderer/src/link/appearance.css';
    import './src/renderer/src/link/lighting.css';
    import './src/renderer/src/link/properties.css';
    import './src/renderer/src/link/interface.css';
    import './src/renderer/src/link/components/lighting-tools.css';
    import './src/renderer/src/link/components/inspector.css';
    const track = { id: 'track', name: '灯光轨道名称很长时也能查看完整内容', kind: 'ma2', color: '#8ab9eb', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 0, noteNames: {}, clips: [{ id: 'lighting-clip', name: '灯光片段', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [{ id: 'point', kind: 'ma2', at: 1000, action: 'goto', label: '灯光点', executor: '1000.101', sequence: 100, cue: '1' }] }] };
    const lighting = { version: 2, tracks: [track], tempos: [{ beat: 0, bpm: 128, numerator: 4, denominator: 4 }], markers: [], loop: { enabled: false, startMs: 0, endMs: 10000 }, outputMode: 'timecode', templates: [{ id: 'template', name: 'MA2AI AUDITION 上下光笼 × 中心雕塑 很长的模板名称', track }] };
    const project = parseLinkProject({ ...createEmptyLinkProject('属性测试'), playbackSource: 'internal', rundown: [{ id: 'song', title: '节目 1', playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 1200000, shortcut: '' } }] });
    useDocumentStore.setState({ project, path: null });
    const noop = () => {};
    const asset = { id: 'asset', name: '素材', kind: 'image', relativePath: 'media/image.png', byteLength: 1024, width: 1080, height: 1920 };
    const clip = { id: 'clip', assetId: 'asset', label: '很长的素材名称_ABCDEFGHIJKLMNOPQRSTUVWXYZ_用于检查属性标题换行', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 10000, obsTransform: 'project', canvasTransform: { x: .5, y: .5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } };
    const cue = { id: 'cue', name: '画面动作', enabled: true, notes: '备注可以展开阅读', timecode: clip.startTimecode, actions: [{ id: 'action', label: '动作', kind: 'midi.noteOn', channel: 1, note: 60, velocity: 100 }] };
    function Harness() {
      const item = useDocumentStore(state => state.project.rundown[0]);
      const [document, change] = useState(lighting);
      const [mode, setMode] = useState('common');
      const audio = useAudioEditor(null, null, false, noop);
      useEffect(() => { const changeMode = event => setMode(event.detail); window.addEventListener('properties-mode', changeMode); return () => window.removeEventListener('properties-mode', changeMode); }, []);
      const contents = mode === 'media' ? <ClipInspector itemId={item.id} clip={clip} asset={asset} notify={noop} onTransform={noop} onSendLookToObs={noop} onUseObsLook={noop} onEmbeddedAudioEnabled={noop} onRemove={noop} />
        : mode === 'cue' ? <CueInspector itemId={item.id} cue={cue} frameRate="30" inventory={null} execute={noop} testAction={async () => {}} />
        : mode === 'audio' ? <AudioInspector editor={{ ...audio, title: '很长的音乐名称_ABCDEFGHIJKLMNOPQRSTUVWXYZ_混音版本', selected: { id: 'segment', startMs: 0, durationMs: 10000, sourceOffsetMs: 0 } }} playhead={new EditorPlayhead()} onRecognise={noop} />
        : mode === 'track' || mode === 'point' ? <div className="lighting-inspector-host"><LightingTimelineInspector document={document} trackId="track" selectedClipId={mode === 'point' ? 'lighting-clip' : null} selectedEventId={mode === 'point' ? 'point' : null} onChange={change} onSelect={noop} /></div>
        : <CommonProperties item={item} document={document} disabled={false} onChange={change} notify={noop} />;
      return <div className="editor-preview-row" style={{ display: 'block', height: '100vh' }}><aside className="cue-inspector panel" style={{ width: '100%', height: '100%' }}>
        <div className="panel-title">属性</div>{contents}
      </aside></div>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  ` }, bundle: true, write: false, outfile: 'editor-properties-test.js', platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'import.meta.hot': 'undefined', 'import.meta.url': JSON.stringify('http://127.0.0.1/editor-properties-test') },
    alias: { '@tb/schema': resolve('../../packages/schema/src/index.ts'), '@tb/core/link': resolve('../../packages/core/src/link-public.ts') } });
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  css = result.outputFiles.find(file => file.path.endsWith('.css'))!.text;
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.route('http://127.0.0.1/editor-properties-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1/editor-properties-test');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
});

for (const width of [320, 480, 800]) {
  test(`属性面板 ${width}px：说明、输入框与折叠区不重叠`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await expect(page.getByLabel('歌曲音量')).toBeVisible();
    const collisions = await page.locator('.song-properties').evaluate(section => {
      const fields = Array.from(section.children).filter(element => element.getBoundingClientRect().height > 0);
      return fields.flatMap((element, index) => fields.slice(index + 1).filter(other => {
        const a = element.getBoundingClientRect(), b = other.getBoundingClientRect();
        return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      }).map(other => [element.textContent, other.textContent]));
    });
    expect(collisions).toEqual([]);
    const overflow = await page.locator('.common-properties').evaluate(element => element.scrollWidth > element.clientWidth);
    expect(overflow).toBe(false);
    await page.getByText('快捷键', { exact: true }).first().click();
    await expect(page.getByLabel('歌曲快捷键')).toBeVisible();
    const end = await page.getByLabel('结束（秒）').boundingBox();
    const shortcut = await page.getByLabel('歌曲快捷键').boundingBox();
    expect(shortcut!.y).toBeGreaterThan(end!.y + end!.height);
    await page.locator('.common-properties').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: test.info().outputPath(`properties-${width}.png`), fullPage: true });
  });
}

for (const mode of ['media', 'cue', 'audio', 'track', 'point']) {
  test(`${mode} 属性：窄面板无横向溢出，控件可到达`, async ({ page }) => {
    await expect(page.getByLabel('歌曲音量')).toBeVisible();
    await page.evaluate(mode => window.dispatchEvent(new CustomEvent('properties-mode', { detail: mode })), mode);
    for (const width of [320, 480]) {
      await page.setViewportSize({ width, height: 720 });
      if (mode === 'track' && await page.locator('.lighting-track-more').getAttribute('open') === null) await page.getByText('更多轨道设置', { exact: true }).click();
      const overflow = await page.locator('.cue-inspector').evaluate(panel => {
        const bounds = panel.getBoundingClientRect();
        return Array.from(panel.querySelectorAll('input, select, button, textarea, .ui-field, .layout-number')).filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1);
        }).map(element => element.getAttribute('aria-label') ?? element.textContent);
      });
      expect(overflow).toEqual([]);
      const controls = page.locator('.cue-inspector input:enabled, .cue-inspector select:enabled, .cue-inspector button:enabled, .cue-inspector textarea:enabled');
      await controls.last().scrollIntoViewIfNeeded();
      await expect(controls.last()).toBeInViewport();
      await page.locator('.inspector-body, .lighting-inspector-host').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: test.info().outputPath(`${mode}-${width}.png`), fullPage: true });
    }
  });
}

test('展开变速点、循环和输入错误时，说明与后续字段保持分离', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 720 });
  await page.getByText('变速点', { exact: true }).click();
  await page.getByRole('button', { name: '添加变速点' }).click();
  await expect(page.getByLabel('变速点 2 BPM')).toHaveValue('128');
  await page.getByRole('switch', { name: '启用循环' }).check();
  await expect(page.getByRole('switch', { name: '启用循环' })).toBeChecked();
  const input = page.getByLabel('MTC 起始时间（时:分:秒）');
  await input.fill('00:2'); await input.press('Enter');
  const error = page.getByRole('alert');
  await expect(error).toContainText('请填写时:分:秒');
  const errorBounds = await error.boundingBox(), next = await page.getByLabel('开始（秒）').boundingBox();
  expect(next!.y).toBeGreaterThan(errorBounds!.y + errorBounds!.height);
});
