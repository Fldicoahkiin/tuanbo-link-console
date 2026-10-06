import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from 'node:inspector';
import { createEmptyLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

// Diagnose the real player without occupying the native soak's MIDI port.
// A diagnostic capture is not MIDI precision or six-hour acceptance.
for (const seconds of [35, 21605]) test(`正式音频启动性能诊断 ${seconds} 秒音源`, async ({}, info) => {
  test.skip(process.env.TBLINK_AUDIO_STARTUP_PROFILE !== '1', '手动诊断，不占用正式 MIDI 输出');
  const wav = Buffer.alloc(44 + seconds * 8000, 128);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  const sha256 = createHash('sha256').update(wav).digest('hex');
  await writeFile(info.outputPath('audio.wav'), wav);
  const project = createEmptyLinkProject('真实播放器启动诊断'); project.playbackSource = 'internal';
  project.rundown.push({ id: 'song', title: '启动诊断', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [],
    referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', durationMs: seconds * 1000, sha256 } });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow();
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const native = process.env.TBLINK_STARTUP_AUDIO_ENGINE === 'native';
  try {
    if (native) {
      const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
      profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null };
      await page.waitForFunction(() => Boolean(window.tbLink));
      await page.evaluate(profile => window.tbLink.saveIntegrationProfile({ profile }), profile); await page.reload();
      await page.waitForFunction(() => Boolean(window.tbLink));
    }
    await page.evaluate(() => {
      const OriginalContext = AudioContext;
      Reflect.set(window, '__audioContextsCreated', 0);
      Reflect.set(window, 'AudioContext', class extends OriginalContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          Reflect.set(window, '__audioContextsCreated', (Reflect.get(window, '__audioContextsCreated') as number) + 1);
        }
      });
    });
    await page.evaluate(({ file, sha256 }) => window.tbLink.saveWaveformCache({ projectPath: file, sha256, peaks: Array.from({ length: 2400 }, () => 0) }), { file, sha256 });
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('.player-transport .primary-button')).toBeEnabled();
    await app.evaluate(async () => {
      const inspector = process.getBuiltinModule('node:inspector');
      const session = new inspector.Session(); session.connect();
      Reflect.set(globalThis, '__startupInspector', session);
      await new Promise<void>((resolve, reject) => session.post('Profiler.enable', error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()));
    });
    await app.evaluate(async ({ BrowserWindow }) => {
      const debuggerApi = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
      debuggerApi.attach('1.3'); await debuggerApi.sendCommand('Profiler.enable'); await debuggerApi.sendCommand('Profiler.start');
    });
    await page.evaluate(() => {
      const samples: { at: number; elapsed: number; playing: boolean }[] = [];
      Reflect.set(window, '__startupGaps', samples);
      let previous = performance.now();
      Reflect.set(window, '__startupTimer', setInterval(() => {
        const now = performance.now(); if (now - previous > 20 && samples.length < 2000) samples.push({ at: now, elapsed: now - previous, playing: Boolean(document.querySelector('.player-transport.status-playing')) }); previous = now;
      }, 5));
    });
    const startedAt = performance.now();
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    const startupMs = performance.now() - startedAt;
    await page.waitForTimeout(10000);
    const status = native ? await page.evaluate(() => window.tbLink.getNativePlaybackStatus()) : null;
    await writeFile(info.outputPath('startup.json'), JSON.stringify({ startupMs, status }, null, 2));
    if (native) { expect(status).toMatchObject({ status: 'playing', audioError: null, underruns: 0 }); expect(status!.positionMs).toBeGreaterThan(9000); }
    await writeFile(info.outputPath('gaps.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__startupGaps') as unknown), null, 2));
    const audioContextsCreated = await page.evaluate(() => Reflect.get(window, '__audioContextsCreated') as number);
    await writeFile(info.outputPath('audio-contexts.json'), JSON.stringify({ audioContextsCreated }));
    expect(audioContextsCreated).toBe(native ? 0 : 1);
    if (native && seconds === 21605) {
      const waveform = page.getByRole('slider', { name: '波形播放位置', exact: true });
      const box = await waveform.boundingBox(); if (!box) throw new Error('波形定位区域不可见');
      const seekAt = performance.now();
      await waveform.click({ position: { x: box.width / 2, y: box.height / 2 } });
      await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.positionMs).toBeGreaterThan(seconds * 500 - 1000);
      await expect(page.locator('.player-transport.status-playing')).toBeVisible();
      const seekMs = performance.now() - seekAt;
      const sought = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
      expect(sought).toMatchObject({ status: 'playing', offsetMs: 0, audioError: null, underruns: 0 });
      await page.waitForTimeout(1200);
      const continued = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
      expect(continued!.positionMs - sought!.positionMs).toBeGreaterThan(1000);
      expect(continued).toMatchObject({ status: 'playing', audioError: null, underruns: 0 });
      await writeFile(info.outputPath('cold-seek.json'), JSON.stringify({ seekMs, sought, continued }, null, 2));
    }
    const gaps = await page.evaluate(() => Reflect.get(window, '__startupGaps') as { elapsed: number }[]);
    expect(Math.max(0, ...gaps.map(gap => gap.elapsed))).toBeLessThanOrEqual(100);
    expect(errors).toEqual([]);
  } finally {
    const mainProfile = await app.evaluate(async () => {
      const session = Reflect.get(globalThis, '__startupInspector') as Session | undefined;
      if (!session) return null;
      try { return await new Promise<unknown>((resolve, reject) => session.post('Profiler.stop', (error, result) => error ? reject(error) : resolve(result))); }
      finally { session.disconnect(); }
    });
    await writeFile(info.outputPath('main-cpu.json'), JSON.stringify(mainProfile));
    const profile = await app.evaluate(async ({ BrowserWindow }) => {
      const debuggerApi = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
      if (!debuggerApi.isAttached()) return null;
      const result: unknown = await debuggerApi.sendCommand('Profiler.stop'); debuggerApi.detach(); return result;
    });
    await writeFile(info.outputPath('cpu.json'), JSON.stringify(profile));
    await writeFile(info.outputPath('gaps.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__startupGaps') as unknown), null, 2));
    await writeFile(info.outputPath('scope.json'), JSON.stringify({ diagnosticOnly: true, seconds, engine: native ? 'native' : 'browser', errors, midiMeasured: false }));
    try {
      await page.getByRole('button', { name: '停止播放', exact: true }).click();
      if (native) await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    } finally {
      await page.evaluate(async () => { clearInterval(Reflect.get(window, '__startupTimer') as number); await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentDirty(false); });
      await app.close();
    }
  }
});
