// Capture the real Electron UI in an isolated profile. No device status is mocked.
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { startWebsiteObs } from './website-obs-session.mjs';

const root = resolve('.');
const directory = resolve(process.argv[2] ?? 'artifacts/website-media');
const req = createRequire(join(root, 'apps/desktop/package.json'));
const { _electron: electron, expect } = req('@playwright/test');
const ffmpeg = req('ffmpeg-static');
const run = promisify(execFile);
await mkdir(directory, { recursive: true });
const bundle = join(directory, 'domain.cjs');
await build({ stdin: { contents: "export * from '@tb/schema'; export {createDefaultIntegrationProfile} from './src/renderer/src/link/view-models/local-integration-profile';", resolveDir: join(root, 'apps/desktop') }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
const domain = req(bundle);
const wav = Buffer.alloc(44 + 48000 * 60 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
// Original instrumental: four chord arpeggio and a quiet kick, 120 BPM.
const notes = [220, 261.626, 329.628, 391.995, 174.614, 220, 261.626, 349.228];
for (let i = 0; i < 48000 * 60; i++) {
  const t = i / 48000, beat = t % .5, note = notes[Math.floor(t * 4) % notes.length];
  const synth = Math.sin(t * note * 2 * Math.PI) * Math.exp(-(t % .25) * 13) * .15;
  const kick = Math.sin(2 * Math.PI * (52 * beat + 3 * (1 - Math.exp(-beat * 30)))) * Math.exp(-beat * 25) * .24;
  wav.writeInt16LE(Math.round((synth + kick) * Math.min(t, 60 - t, 1) * 22000), 44 + i * 2);
}
await writeFile(join(directory, 'music.wav'), wav);
await run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'gradients=s=720x1280:r=30:c0=0x102d52:c1=0x6292a8:n=2:speed=0.025', '-t', '60', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p', join(directory, 'visual.mp4')], { windowsHide: true });
const video = await readFile(join(directory, 'visual.mp4'));
const time = seconds => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const lighting = domain.createLightingDocument();
lighting.tempos = [{ beat: 0, bpm: 120, numerator: 4, denominator: 4 }];
lighting.markers = [{ id: 'intro', name: '前奏', startMs: 0, endMs: 16000 }, { id: 'chorus', name: '主段', startMs: 16000, endMs: 48000 }, { id: 'end', name: '收尾', startMs: 48000, endMs: 60000 }];
lighting.tracks = [{ id: 'light', name: '灯光 Cue', kind: 'ma2', color: '#8db8e7', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'light-clip', name: '主节目灯光', start: 0, duration: 60000, timeLock: 'time', muted: false, events: [0, 8, 16, 24, 32, 40, 48, 56].map((sec, i) => ({ id: 'cue-' + i, kind: 'ma2', at: sec * 1000, action: 'goto', sequence: 1, cue: String(i % 4 + 1) + '.000', executor: '', label: ['开场蓝', '侧光', '主段白', '收尾'][i % 4] })) }] }];
const project = domain.parseLinkProject({ ...domain.createEmptyLinkProject('官网演示 · 直播剪辑化'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes', outputCanvas: { width: 720, height: 1280 },
  mediaAssets: [{ id: 'visual', kind: 'video', name: '原创渐变背景', relativePath: 'visual.mp4', sha256: createHash('sha256').update(video).digest('hex'), byteLength: video.length, durationMs: 60000, width: 720, height: 1280 }],
  ma2MaterialLibrary: { version: 2, source: 'website-demo', userLibrary: domain.createLightingUserLibrary(), library: { directory: { show: '官网演示素材（离线）', generation: 'website', version: '3.7.0.5', entries: [] }, readAt: new Date().toISOString(), sequences: [{ sequence: 1, name: '主节目灯光', cues: ['开场蓝', '侧光', '主段白', '收尾'].map((name, i) => ({ index: i, number: `${i + 1}.000`, name })) }], fixtureUsage: [], errors: [] } },
  rundown: ['开场', '主节目', '返场'].map((title, i) => ({ id: 'song-' + i, title, referenceAudio: { assetId: 'music', relativePath: 'music.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 60000 }, lighting: structuredClone(lighting),
    visualLayers: [{ id: `camera-${i}`, name: '机位' }, { id: `video-${i}`, name: '背景素材' }],
    referenceMediaClips: [{ id: `background-${i}`, assetId: 'visual', label: '原创背景', layerId: `video-${i}`, startTimecode: time(0), durationMs: 60000 }],
    cues: [8, 20, 36, 48].map((sec, index) => ({ id: `scene-${i}-${index}`, name: index % 2 ? '机位 B · 近景' : '机位 A · 全景', layerId: `camera-${i}`, timecode: time(sec), durationMs: 6000, actions: [{ id: `switch-${i}-${index}`, label: '切换机位', kind: 'obs.setProgramScene', sceneName: index % 2 ? '官网演示 B' : '官网演示 A' }] })) })) });
const projectPath = join(directory, '直播剪辑化.tblink');
await writeFile(projectPath, JSON.stringify(project, null, 2));
const fixedBuild = join(root, 'apps/desktop/out-website-capture');
await cp(join(root, 'apps/desktop/out'), fixedBuild, { recursive: true });
const env = { ...process.env, TBLINK_LOCAL_TEST_ACCESS: '1' }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const obs = await startWebsiteObs(root, directory, req('obs-websocket-js').default);
const app = await electron.launch({ args: [`--user-data-dir=${join(directory, 'profile-recording')}`, join(fixedBuild, 'main/index.cjs')], env, recordVideo: { dir: join(directory, 'recordings'), size: { width: 1440, height: 900 } } });
let page;
try {
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1440, 900); });
  await page.waitForFunction(() => Boolean(globalThis.window.tbLink));
  const profile = domain.createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false; profile.obs.executablePath = obs.executable; profile.obs.webSocketUrl = obs.url;
  await page.evaluate(profile => globalThis.window.tbLink.saveIntegrationProfile({ profile, obsPassword: '' }), profile);
  await page.evaluate(path => localStorage.setItem('tblink.last-project-path.v1', path), projectPath);
  await page.reload();
  await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => globalThis.window.tbLink.connectObs());
  const nav = page.getByRole('navigation', { name: '主要工作区' });
  await page.screenshot({ path: join(directory, 'programs.png') });
  console.log('PROGRAMS', await page.locator('body').innerText());
  await nav.getByRole('button', { name: '编辑器', exact: true }).click();
  await page.waitForTimeout(15000);
  await page.screenshot({ path: join(directory, 'timeline.png') });
  console.log('EDITOR', await page.locator('body').innerText());
  await nav.getByRole('button', { name: '灯光工作台', exact: true }).click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(directory, 'lighting.png') });
  console.log('LIGHTING', await page.locator('body').innerText());
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '设备连接', exact: true }).click();
  await page.waitForTimeout(800); await page.screenshot({ path: join(directory, 'connections.png') });
  await writeFile(join(directory, 'capture.json'), JSON.stringify({ capturedAt: new Date().toISOString(), version: '0.4.46', projectPath, realUI: true, deviceMocks: false, obs: 'real-isolated-process', lighting: 'offline-editing', video: await page.video()?.path() }, null, 2));
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => globalThis.window.tbLink.setDocumentDirty(false));
  await app.close();
  await obs.close();
}
