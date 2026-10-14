import { test, expect, _electron as electron } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativePlayerPrepare, NativePlayerStatus } from '@tb/schema';

test('真实 Electron IPC：独立音频时钟承受界面阻塞，界面崩溃后停止自有引擎', async ({}, info) => {
  test.skip(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1', '需要本机 WASAPI；不占 MIDI 长测端口');
  const wav = Buffer.alloc(44 + 48000 * 4 * 20);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let frame = 0; frame < 48000 * 20; frame++) {
    const sample = Math.sin(frame * 2 * Math.PI * 1500 / 48000);
    wav.writeInt16LE(Math.round(sample * 512), 44 + frame * 4);
    wav.writeInt16LE(Math.round(sample * 256), 46 + frame * 4);
  }
  await writeFile(info.outputPath('audio.wav'), wav);
  const request: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1, projectPath: info.outputPath('project.tblink'),
    snapshot: { version: 1, projectId: 'native-test', itemId: 'song', revision: 1,
      audio: { relativePath: 'audio.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 20000 },
      startMs: 1000, positionMs: 1500, endMs: 18000, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 0 },
    audioDeviceId: 'default', midiPortName: null };
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow();
  const evidence: Record<string, unknown> = { scope: '真实 Electron → 主进程服务 → WASAPI；不代表正式播放按钮、MIDI、OBS 或六小时验收', passed: false };
  let enginePid: number | null = null, crashed = false;
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    const prepared = await page.evaluate(async request => {
      const events: NativePlayerStatus[] = [];
      Reflect.set(window, '__nativeEvents', events);
      window.tbLink.onNativePlaybackStatus(state => events.push(state));
      return window.tbLink.prepareNativePlayback(request);
    }, request);
    enginePid = prepared.enginePid; expect(enginePid).toBeGreaterThan(0);
    await page.evaluate(request => window.tbLink.controlNativePlayback({ version: 1, sessionId: request.sessionId, generation: 2, kind: 'play' }), request);
    await page.evaluate(request => window.tbLink.controlNativePlayback({ version: 1, sessionId: request.sessionId, generation: 2, kind: 'volume', volume: 1, durationMs: 1000 }), request);
    const before = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    await page.evaluate(() => { const end = performance.now() + 700; while (performance.now() < end) { /* Deliberate renderer fault injection. */ } });
    const after = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(after?.status).toBe('playing'); expect(after!.positionMs - before!.positionMs).toBeGreaterThan(600);
    expect(after?.audioError).toBeNull(); expect(after?.underruns).toBe(0);
    expect(after!.gain).toBeGreaterThan(0.5);
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.gain).toBe(1);
    const monitoring = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
    expect(monitoring!.analysis!.peaks[0]).toBeCloseTo(512 / 32768, 7);
    expect(monitoring!.analysis!.peaks[1]).toBeCloseTo(256 / 32768, 7);
    expect(monitoring!.analysis!.spectrum.indexOf(Math.max(...monitoring!.analysis!.spectrum))).toBe(64);
    const paused = await page.evaluate(request => window.tbLink.controlNativePlayback({ version: 1, sessionId: request.sessionId, generation: 3, kind: 'pause' }), request);
    await page.waitForTimeout(150);
    expect((await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.positionMs).toBe(paused.positionMs);
    const resumed = await page.evaluate(request => window.tbLink.controlNativePlayback({ version: 1, sessionId: request.sessionId, generation: 4, kind: 'play' }), request);
    expect(resumed.status).toBe('playing');
    evidence.before = before; evidence.after = after; evidence.paused = paused; evidence.monitoring = monitoring;
    evidence.events = await page.evaluate(() => Reflect.get(window, '__nativeEvents') as unknown);
    crashed = true;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
    // Inspect the OS process directly: the crashed renderer cannot service a browser round trip.
    await expect.poll(() => {
      try { process.kill(enginePid!, 0); return true; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false; throw error; }
    }, { timeout: 10000 }).toBe(false);
    evidence.engineExitedAfterRendererCrash = true; evidence.passed = true;
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    if (!crashed) await page.evaluate(request => window.tbLink.controlNativePlayback({ version: 1, sessionId: request.sessionId, generation: 100, kind: 'stop' }), request);
    await app.close();
  }
});
