import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { startWebsiteObs, resumeWebsiteObs } from './website-obs-session.mjs';
const root = resolve('.'), source = resolve('artifacts/website-media'), directory = resolve('artifacts/website-recording');
await mkdir(directory, { recursive: true });
const req = createRequire(join(root, 'apps/desktop/package.json'));
const { _electron: electron, expect } = req('@playwright/test');
const ffmpeg = req('ffmpeg-static'), run = promisify(execFile);
const domain = req(join(source, 'domain.cjs'));
const obs = process.argv.includes('--resume-owned-obs') ? await resumeWebsiteObs(directory, req('obs-websocket-js').default) : await startWebsiteObs(root, directory, req('obs-websocket-js').default);
const env = { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({ args: [`--user-data-dir=${join(directory, 'profile-' + Date.now())}`, join(root, 'apps/desktop/out-website-capture/main/index.cjs')], env, timeout: 30000 });
let page; const evidence = { capturedAt: new Date().toISOString(), softwareVersion: '0.4.46', sourceBuild: 'isolated snapshot of local build', realUI: true, deviceMocks: false, obs: 'real isolated OBS 32.2.2', lighting: 'offline Cue editing; no connected console or real fixtures', scenes: 'original color/title example scenes, not live cameras', recordings: [], observations: [] };
const web = join(root, 'apps/licensing-server/web');
await mkdir(join(web, 'media'), { recursive: true });
await mkdir(join(web, 'assets'), { recursive: true });
async function screenshot(name) {
  const png = join(directory, name + '.png'); await page.screenshot({ path: png });
  await run(ffmpeg, ['-y', '-v', 'error', '-i', png, '-c:v', 'libwebp', '-quality', '87', join(web, 'assets', `20261010-${name}.webp`)], { windowsHide: true });
}
async function record(name, seconds, action) {
  const frames = join(directory, name); await mkdir(frames, { recursive: true });
  const started = performance.now(), captured = [];
  // Sequential real screenshots with measured intervals: preserve original timing.
  const capture = (async () => {
    while (performance.now() - started < seconds * 1000) {
      const timestamp = performance.now() - started, file = `${String(captured.length).padStart(5, '0')}.jpg`;
      await page.screenshot({ path: join(frames, file), type: 'jpeg', quality: 90 }); captured.push({ timestamp, file });
      await new Promise(resolve => setTimeout(resolve, 90));
    }
  })();
  let actionError;
  try { await action(); } catch (error) { actionError = error; }
  await capture;
  if (actionError) throw actionError;
  const list = captured.map((frame, i) => `file '${frame.file}'\nduration ${Math.max(.01, ((captured[i + 1]?.timestamp ?? seconds * 1000) - frame.timestamp) / 1000)}`).join('\n');
  await writeFile(join(frames, 'frames.txt'), list + `\nfile '${captured.at(-1).file}'\n`);
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'frames.txt'), '-t', String(seconds), '-r', '30', '-vf', 'scale=1440:900', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(web, 'media', `20261010-${name}.mp4`)], { windowsHide: true });
  evidence.recordings.push({ name, seconds, frames: captured.length, timing: 'measured wall-clock intervals, original speed' });
  console.log(`已录制 ${name}：${seconds} 秒，${captured.length} 个真实屏幕帧`);
}
try {
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  await page.waitForFunction(() => Boolean(globalThis.window.tbLink));
  const profile = domain.createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false; profile.obs.executablePath = obs.executable; profile.obs.webSocketUrl = obs.url;
  await page.evaluate(profile => globalThis.window.tbLink.saveIntegrationProfile({ profile, obsPassword: '' }), profile);
  await page.evaluate(path => localStorage.setItem('tblink.last-project-path.v1', path), join(source, '直播剪辑化.tblink'));
  await page.reload();
  const nav = page.getByRole('navigation', { name: '主要工作区' }); await expect(nav).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => globalThis.window.tbLink.connectObs());
  await nav.getByRole('button', { name: '节目单', exact: true }).click();
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: '详细', exact: true }).click();
  await page.getByRole('button', { name: /MTC 状态：/ }).click();
  await page.getByRole('button', { name: 'MTC 开', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '详细', exact: true }).click();
  evidence.mtcOutput = 'explicitly disabled in real UI: offline editing demo';
  await screenshot('programs');
  await record('programs', 20, async () => {
    await page.getByRole('button', { name: '编辑内容', exact: true }).click();
    await page.getByRole('button', { name: '修改节目名称：开场', exact: true }).click();
    await page.getByLabel('当前节目名称', { exact: true }).fill('开场 · 暖场音乐');
    await page.getByLabel('当前节目名称', { exact: true }).press('Enter');
    await page.waitForTimeout(3000);
    await page.getByRole('button', { name: '修改节目名称：开场 · 暖场音乐', exact: true }).click();
    await page.getByLabel('当前节目名称', { exact: true }).fill('开场');
    await page.getByLabel('当前节目名称', { exact: true }).press('Enter');
    await nav.getByRole('button', { name: '节目单', exact: true }).click();
  });
  await nav.getByRole('button', { name: '编辑器', exact: true }).click();
  await expect(page.locator('canvas[aria-label="OBS 实时画面"]')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1000);
  const seek = async seconds => {
    const width = await page.locator('.timeline-clip.video').first().evaluate(el => el.getBoundingClientRect().width);
    await page.locator('.timeline-ruler').click({ position: { x: Math.min(width * seconds / 60, 950), y: 13 } });
    await page.waitForTimeout(1500);
    evidence.observations.push({ seekSeconds: seconds, scene: (await obs.socket.call('GetCurrentProgramScene')).currentProgramSceneName });
  };
  await seek(5); await page.waitForTimeout(1000); await screenshot('timeline');
  await record('timeline', 20, async () => {
    await page.locator('.timeline-clip.video').first().click();
    const clip = await page.locator('.timeline-clip.video').first().boundingBox();
    await page.mouse.move(clip.x + 75, clip.y + 16); await page.mouse.down();
    await page.mouse.move(clip.x + 135, clip.y + 16, { steps: 20 }); await page.mouse.up();
    await page.waitForTimeout(1000); await page.getByRole('button', { name: '撤销', exact: true }).click();
    const trim = await page.locator('.timeline-trim-handle.start').first().boundingBox();
    await page.mouse.move(trim.x + trim.width / 2, trim.y + trim.height / 2); await page.mouse.down();
    await page.mouse.move(trim.x + 75, trim.y + trim.height / 2, { steps: 20 }); await page.mouse.up();
    await page.waitForTimeout(1000); await page.getByRole('button', { name: '撤销', exact: true }).click();
    await seek(5);
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await page.waitForTimeout(5000);
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
  });
  await seek(10); await screenshot('cameras');
  await record('cameras', 20, async () => { await seek(10); await seek(22); await seek(3); await seek(10); await seek(22); });
  await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
  await page.waitForTimeout(2500);
  await screenshot('lighting');
  await record('lighting', 30, async () => {
    const cue = page.locator('.waveform-cue-point').nth(2);
    await cue.dblclick();
    await page.getByLabel('时间（秒）', { exact: true }).fill('17');
    await page.getByRole('button', { name: '保存卡点', exact: true }).click();
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.waitForTimeout(1500);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await page.waitForTimeout(7000);
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
  });
  await screenshot('rehearsal');
  await nav.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '设备连接', exact: true }).click();
  await screenshot('connections');
  const concat = join(web, 'media/concat.txt');
  await writeFile(concat, ['programs', 'timeline', 'cameras', 'lighting'].map(name => `file '20261010-${name}.mp4'`).join('\n'));
  await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-c', 'copy', '-movflags', '+faststart', join(web, 'media/20261010-overview.mp4')], { windowsHide: true });
  // Keep the full raw segment and publish a 20-second excerpt beside the feature.
  await copyFile(join(web, 'media/20261010-lighting.mp4'), join(directory, 'lighting-original.mp4'));
  await run(ffmpeg, ['-y', '-v', 'error', '-i', join(directory, 'lighting-original.mp4'), '-t', '20', '-c:v', 'libx264', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(web, 'media/20261010-lighting.mp4')], { windowsHide: true });
  await writeFile(join(web, 'media/20261010-overview.vtt'), 'WEBVTT\n\n00:00.000 --> 00:10.000\n节目编排：修改节目名称，保存每首节目的安排。\n\n00:10.000 --> 00:20.000\n从节目单进入编辑器，再返回节目单。\n\n00:20.000 --> 00:30.000\n素材编排：移动片段、修剪入点，再撤销并播放检查。\n\n00:30.000 --> 00:40.000\n播放并检查时间线。真实 OBS 示例场景。\n\n00:40.000 --> 01:00.000\n机位切换：移动播放位置，核对 A / B 场景与素材的切换。\n\n01:00.000 --> 01:15.000\n灯光编辑：调整 Cue 时间，撤销、重做。\n\n01:15.000 --> 01:30.000\n灯光为离线编排演示，未连接实体控台。\n');
  const files = [];
  for (const name of ['programs', 'timeline', 'cameras', 'lighting', 'connections', 'rehearsal']) files.push({ path: `assets/20261010-${name}.webp`, kind: 'real-application-screenshot' });
  for (const name of ['programs', 'timeline', 'cameras', 'lighting', 'overview']) files.push({ path: `media/20261010-${name}.mp4`, kind: 'real-application-recording', durationSeconds: name === 'overview' ? 90 : 20, poster: `assets/20261010-${name === 'overview' ? 'timeline' : name}.webp`, subtitles: name === 'overview' ? 'media/20261010-overview.vtt' : null });
  files.push({ path: 'media/20261010-overview.vtt', kind: 'subtitles' });
  for (const file of files) { const bytes = await readFile(join(web, file.path)); file.sha256 = createHash('sha256').update(bytes).digest('hex'); file.bytes = bytes.length; }
  await writeFile(join(web, 'media.json'), JSON.stringify({ version: 1, softwareVersion: '0.4.46', status: 'development-preview', source: 'isolated Electron application, original demo project', lighting: 'offline editing; no hardware output claim', scenes: 'Original OBS title/color scenes; not live cameras', audio: 'Silent real-application screen recording; original music source supplied separately', files }, null, 2));
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
} catch (error) {
  await writeFile(join(directory, 'failure.txt'), `${error.stack}\n${page ? await page.locator('body').innerText() : ''}`); throw error;
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => globalThis.window.tbLink.setDocumentDirty(false));
  await app.close();
  try { await obs.close(); } catch (error) { await writeFile(join(directory, 'cleanup.txt'), '正常关闭未完成，保留本次隔离 OBS；没有强杀。\n' + error.message); console.error('隔离 OBS 未完成正常关闭，进程身份已记录。'); }
}
