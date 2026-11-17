import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';

let script: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
    import { SongMtcStartInput } from './src/renderer/src/link/components/SongPlaybackProperties';
    import { PlayerStatusDetails } from './src/renderer/src/link/components/PlayerStatusDetails';
    import { useDocumentStore } from './src/renderer/src/link/stores/document-store';
    import { useShowStateStore } from './src/renderer/src/link/stores/show-state-store';
    const project = parseLinkProject({ ...createEmptyLinkProject('输入测试'), playbackSource: 'internal',
      rundown: ['a', 'b'].map((id, index) => ({ id, title: id, playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: (index + 1) * 60000, shortcut: '' } })) });
    useDocumentStore.setState({ project, path: null });
    window.addEventListener('external-start', () => {
      const next = structuredClone(useDocumentStore.getState().project);
      next.rundown[0].playback.mtcOffsetMs = 180000;
      useDocumentStore.setState({ project: next });
    });
    window.addEventListener('hold-song', () => useShowStateStore.setState({ show: { phase: 'held', source: 'internal', itemId: 'a', program: null } }));
    window.addEventListener('stop-song', () => useShowStateStore.setState({ show: { phase: 'idle', source: null, itemId: null, program: null } }));
    window.addEventListener('composition-enter', () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    function Harness() {
      const project = useDocumentStore(state => state.project);
      const [id, select] = useState('a'), [notice, notify] = useState('');
      const item = project.rundown.find(item => item.id === id);
      return <><button onClick={() => select(id === 'a' ? 'b' : 'a')}>换歌</button>
        <SongMtcStartInput item={item} notify={notify} aria-label="起始时间" />
        <output aria-label="已存毫秒">{item.playback.mtcOffsetMs}</output><output aria-label="通知">{notice}</output>
        <PlayerStatusDetails error="测试故障，请更换音频" errorTitle="播放操作失败" notice="测试故障，请更换音频" fault={null} engine="测试引擎" />
      </>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  ` }, bundle: true, write: false, outfile: 'mtc-start-test.js', platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'import.meta.hot': 'undefined', 'import.meta.url': JSON.stringify('http://127.0.0.1/mtc-start-test') },
    alias: { '@tb/schema': resolve('../../packages/schema/src/index.ts'), '@tb/core/link': resolve('../../packages/core/src/link-public.ts') } });
  script = result.outputFiles.find(file => file.path.endsWith('.js'))!.text;
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error; });
  await page.route('http://127.0.0.1/mtc-start-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1/mtc-start-test');
  await page.addScriptTag({ content: script });
});

test('逐字输入不被后台起始码更新打断；回车提交三段时间', async ({ page }) => {
  const input = page.getByRole('textbox', { name: '起始时间' });
  await expect(input).toHaveValue('00:01:00');
  await input.fill('00:2');
  await page.evaluate(() => window.dispatchEvent(new Event('external-start')));
  await expect(input).toBeFocused(); await expect(input).toHaveValue('00:2');
  await input.pressSequentially('0:00'); await input.press('Enter');
  await expect(input).toHaveValue('00:20:00');
  await expect(page.getByLabel('已存毫秒')).toHaveText('1200000');
  await expect(page.getByLabel('通知')).toBeEmpty();
});

test('格式未完整保留草稿和可操作提示，中文冒号及纯数字可保存，Escape 不保存', async ({ page }) => {
  const input = page.getByRole('textbox', { name: '起始时间' });
  await input.fill('00:2'); await input.press('Enter');
  await expect(input).toHaveValue('00:2'); await expect(page.getByRole('alert').first()).toContainText('请填写时:分:秒');
  await input.fill('00：02：00'); await input.press('Tab'); await expect(input).toHaveValue('00:02:00');
  await input.fill('003000'); await input.press('Enter'); await expect(input).toHaveValue('00:30:00');
  await input.fill('004000'); await input.press('Escape'); await expect(input).toHaveValue('00:30:00');
  await expect(page.getByLabel('已存毫秒')).toHaveText('1800000');
});

test('输入法确认不保存；未编辑字段跟随后台更新；换歌清除旧草稿', async ({ page }) => {
  const input = page.getByRole('textbox', { name: '起始时间' });
  await input.focus(); await page.evaluate(() => window.dispatchEvent(new Event('external-start')));
  await expect(input).toHaveValue('00:03:00');
  await input.fill('001200'); await page.evaluate(() => window.dispatchEvent(new Event('composition-enter')));
  await expect(input).toBeFocused(); await expect(page.getByLabel('已存毫秒')).toHaveText('180000');
  await input.fill('未完成'); await page.getByRole('button', { name: '换歌' }).click();
  await expect(input).toHaveValue('00:02:00');
});

test('暂停歌曲明确说明要停止，其他歌曲仍能修改；播放故障不重复展示', async ({ page }) => {
  const input = page.getByRole('textbox', { name: '起始时间' });
  await page.evaluate(() => window.dispatchEvent(new Event('hold-song')));
  await expect(input).toBeDisabled(); await expect(page.getByRole('status').first()).toContainText('停下它以后');
  await page.getByRole('button', { name: '换歌' }).click(); await expect(input).toBeEnabled();
  await page.getByRole('button', { name: '换歌' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('stop-song'))); await expect(input).toBeEnabled();
  await page.getByLabel('播放状态详情', { exact: true }).first().click();
  await expect(page.locator('.player-error')).toHaveCount(1); await expect(page.locator('.player-notice')).toHaveCount(0);
});
