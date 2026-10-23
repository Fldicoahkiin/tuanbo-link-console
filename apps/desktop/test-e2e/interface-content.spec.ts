import { test, expect, _electron as electron } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';

test('重设计工作区的长节目单、真实波形、素材与放大布局', async ({}, info) => {
  const wav = Buffer.alloc(44 + 48000 * 12 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let sample = 0; sample < 48000 * 12; sample++) wav.writeInt16LE(Math.round(Math.sin(sample / 48000 * 220 * Math.PI * 2) * 14000 * Math.exp(-(sample % 24000) / 6000)), 44 + sample * 2);
  await writeFile(info.outputPath('reference.wav'), wav);
  const referenceAudio = { assetId: 'reference', relativePath: 'reference.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 12000 };
  const templates = ['开场 · 蓝色光束', '主舞 · 暖白追光', '副歌 · 全场频闪', '收尾 · 缓慢渐暗', '城市夜色 · 移动光束', '返场 · 全场亮起'].map((name, index) => ({
    id: `effect-${index}`, name, categories: ['光束'], track: lightingTrackSchema.parse({ id: `template-${index}`, name, kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: 1, cue: String(index + 1), executor: '1.101' } })
  }));
  const lighting = { ...createLightingDocument(), templates, tracks: [lightingTrackSchema.parse({ ...templates[0]!.track, id: 'stage-lighting', clips: [{ id: 'show-clip', name: '开场灯光', start: 0, duration: 12000, timeLock: 'time', muted: false, events: [1000, 3500, 7000].map((at, index) => ({ id: `cue-${index}`, kind: 'ma2', at, label: templates[index]!.name, action: 'goto', sequence: 1, cue: String(index + 1), executor: '1.101' })) }] })] };
  const titles = ['开场 · 城市苏醒', '第一幕 · 追光', '双人舞 · 夜色与霓虹', '返场 · 一起出发'];
  const project = parseLinkProject({ ...createEmptyLinkProject('秋日舞台 · 完整编排示例'), schemaVersion: 2, playbackSource: 'internal', rundown: Array.from({ length: 24 }, (_, index) => ({ id: `song-${index}`, title: index < titles.length ? titles[index] : `第 ${index + 1} 幕 · 城市夜色与长名称显示验收 / A long programme title`, cues: [], referenceAudio, ...(index === 0 ? { lighting } : {}) })) });
  const file = info.outputPath('show.tblink');
  await writeFile(file, JSON.stringify(project));
  const executablePath = process.env.TBLINK_E2E_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [`--user-data-dir=${info.outputPath('profile')}`, ...(executablePath ? [] : [join(process.cwd(), 'out/main/index.cjs')])] });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('.p1-media-card')).toHaveCount(24);
    await expect(page.locator('.monitor-duration')).toContainText('总时长 00:00:12');
    const nav = page.getByRole('navigation', { name: '主要工作区' });
    await page.locator('.player-buttons .primary-button').click();
    await expect(page.locator('.unified-player .mtc-output-status')).toHaveCount(0);
    await page.getByRole('button', { name: '详细', exact: true }).click();
    await page.getByRole('button', { name: /^MTC 状态：/ }).click();
    const mtcDialog = page.getByRole('dialog', { name: 'MTC 时间码状态' });
    await expect(mtcDialog).toBeVisible();
    await expect(mtcDialog.locator('.mtc-output-status')).toBeVisible();
    const toggle = mtcDialog.getByRole('button', { name: /^MTC / });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await mtcDialog.getByRole('button', { name: '音频与 MIDI 设置', exact: true }).click();
    await expect(page.getByLabel('音频与 MIDI 设备面板', { exact: true })).toBeVisible();
    await nav.getByRole('button', { name: '节目单', exact: true }).click();
    await page.getByRole('button', { name: '停止播放', exact: true }).click();
    await expect(page.locator('.unified-player').getByRole('button', { name: /^MTC / })).toHaveCount(0);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { localStorage.setItem('tblink.appearance.v1', value); window.dispatchEvent(new Event('tblink-appearance-change')); }, theme);
      for (const size of [[1540, 960], [1180, 720]]) {
        await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]?.setSize(value[0]!, value[1]!), size);
        await nav.getByRole('button', { name: '节目单', exact: true }).click();
        await expect(page.getByLabel('节目列表', { exact: true })).toBeVisible();
        await page.locator('[data-program-id="song-0"]').focus();
        await page.keyboard.press('End');
        await expect(page.locator('[data-program-id="song-23"]')).toBeInViewport();
        await page.keyboard.press('Home');
        await expect(page.locator('[data-program-id="song-0"]')).toBeInViewport();
        for (const name of ['节目单', '编辑器', '灯光工作台']) {
          await nav.getByRole('button', { name, exact: true }).click();
          if (name === '灯光工作台') {
            await expect(page.getByLabel('选中 Cue 实时播放', { exact: true })).toBeHidden();
            await expect(page.locator('[data-waveform-engine="wavesurfer"][data-ready="true"]').first()).toBeVisible();
            await page.getByRole('navigation', { name: '灯光素材主菜单' }).getByRole('button', { name: '效果', exact: true }).click();
            await page.getByLabel('分类搜索范围', { exact: true }).selectOption('all');
            for (const template of templates) await expect(page.locator('.classification-cell>button').filter({ hasText: template.name })).toBeVisible();
          }
          await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          await page.screenshot({ path: info.outputPath(`${theme}-${size[0]}-${name}.png`) });
          const layout = await page.locator('.app-workspace').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
            overflow: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1).slice(0, 30).map(child => ({ tag: child.tagName, classes: child.className, right: child.getBoundingClientRect().right })) }));
          expect(layout.scrollWidth, JSON.stringify({ theme, size, name, layout })).toBeLessThanOrEqual(layout.width);
        }
      }
    }
    for (const zoom of [1.25, 1.5, 2]) {
      await app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0]?.webContents.setZoomFactor(value), zoom);
      for (const name of ['节目单', '编辑器', '灯光工作台', '设置']) {
        await nav.getByRole('button', { name, exact: true }).click();
        const shell = await page.locator('.app-shell').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
          overflow: [...element.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > element.getBoundingClientRect().right + 1).slice(0, 24).map(child => ({ tag: child.tagName, classes: child.className, right: child.getBoundingClientRect().right })) }));
        expect(shell.scrollWidth, JSON.stringify({ zoom, name, shell })).toBeLessThanOrEqual(shell.width);
        const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage()).toPNG().toString('base64'));
        await writeFile(info.outputPath(`zoom-${zoom}-${name}.png`), Buffer.from(capture, 'base64'));
      }
    }
    expect(errors).toEqual([]);
  } catch (error) {
    const page = await app.firstWindow();
    await writeFile(info.outputPath('failure-ui.txt'), await page.locator('body').innerText());
    await page.screenshot({ path: info.outputPath('failure-ui.png') });
    throw error;
  } finally { const page = await app.firstWindow(); if (!page.isClosed()) await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }); }); await app.close(); }
});
