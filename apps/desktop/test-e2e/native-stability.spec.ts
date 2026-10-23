import { test, expect, _electron as electron } from '@playwright/test';
import { copyFile, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';
import { measurePlaybackProcesses } from './stability-process-metrics';

test('高负载工程正式原生音频连续节目与界面交互', async ({}, info) => {
  test.skip(!process.env.TBLINK_NATIVE_STABILITY_SECONDS || !process.env.TBLINK_STABILITY_FIXTURE, '需独立 WASAPI 验收及高负载工程；本项不启用外部输出');
  const seconds = Number(process.env.TBLINK_NATIVE_STABILITY_SECONDS);
  if (!Number.isInteger(seconds) || seconds < 120 || seconds > 21600) throw new Error('正式播放器长测时长必须为 120 至 21600 秒');
  test.setTimeout(seconds * 1000 + 120000);
  const original = resolve(process.env.TBLINK_STABILITY_FIXTURE!), file = join(dirname(original), `native-acceptance-${randomUUID()}.tblink`);
  await copyFile(original, file);
  const project = parseLinkProject(JSON.parse(await readFile(file, 'utf8')));
  expect(project.rundown).toHaveLength(200); expect(project.mediaAssets).toHaveLength(2000);
  const cueCount = project.rundown.reduce((total, item) => total + item.cues.length
    + (item.lighting?.tracks.reduce((tracks, track) => tracks + track.clips.reduce((clips, clip) => clips + clip.events.length, 0), 0) ?? 0), 0);
  expect(cueCount, '高负载工程的画面与灯光 Cue 总量').toBe(50000);
  expect(project.playbackSource).toBe('internal');
  expect(project.rundown.slice(0, -1).every(item => item.playback?.endAction === 'next')).toBe(true);
  expect(project.rundown.at(-1)?.playback?.endAction).toBe('pause');
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, resolve(process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await app.firstWindow(), errors: string[] = [], visited = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  const scope = '真实正式播放器/WASAPI + 200节目、2000素材、5万Cue的本机UI交互；MIDI、OBS、实体MA2不参与，不作为声光画面全链路验收';
  let started = 0, passed = false, failure: string | null = null;
  const measurements = { samples: 0, maximumUiGapMs: 0, maximumProcessTreePrivateBytes: 0, maximumUnderruns: 0 };
  const engineSha256 = createHash('sha256').update(await readFile(process.env.TBLINK_PLAYBACK_ENGINE_EXE!)).digest('hex');
  const profileCpu = process.env.TBLINK_NATIVE_STABILITY_PROFILE === '1';
  const traceUi = profileCpu || process.env.TBLINK_NATIVE_STABILITY_TRACE_UI === '1';
  const stressUi = process.env.TBLINK_NATIVE_STABILITY_STRESS_UI === '1';
  let diagnosticsCaptured = false;
  const captureDiagnostics = async (): Promise<void> => {
    if (traceUi && !diagnosticsCaptured) {
      diagnosticsCaptured = true;
      const diagnostics = await app.evaluate(async ({ BrowserWindow }, profileCpu) => {
        const debug = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
        if (!debug.isAttached()) return null;
        const cpu: unknown = profileCpu ? await debug.sendCommand('Profiler.stop') : null;
        const complete = new Promise<string>(resolve => {
          debug.on('message', (_event, method, params: { stream?: string }) => { if (method === 'Tracing.tracingComplete' && params.stream) resolve(params.stream); });
        });
        await debug.sendCommand('Tracing.end'); const handle = await complete;
        let trace = '', eof = false;
        while (!eof) { const part = await debug.sendCommand('IO.read', { handle }) as { data: string; eof: boolean }; trace += part.data; eof = part.eof; }
        await debug.sendCommand('IO.close', { handle }); debug.detach(); return { cpu, trace };
      }, profileCpu);
      if (diagnostics) {
        if (diagnostics.cpu) await writeFile(info.outputPath('renderer-cpu.json'), JSON.stringify(diagnostics.cpu));
        await writeFile(info.outputPath('renderer-trace.json'), diagnostics.trace);
      }
    }
  };
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
    profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 };
    await page.evaluate(profile => window.tbLink.saveIntegrationProfile({ profile }), profile); await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await expect(page.locator('[data-total-programs]')).toHaveAttribute('data-total-programs', '200');
    await expect(page.locator('.player-transport .primary-button')).toBeEnabled();
    // Explicitly disable this instance's MTC before preparation. The independent
    // prototype loopback owns its test port and must never receive a second sender.
    await page.locator('.player-transport .primary-button').click();
    await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    if (traceUi) await app.evaluate(async ({ BrowserWindow }, profileCpu) => {
      const debug = BrowserWindow.getAllWindows()[0]!.webContents.debugger;
      debug.attach('1.3');
      if (profileCpu) { await debug.sendCommand('Profiler.enable'); await debug.sendCommand('Profiler.start'); }
      await debug.sendCommand('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: {
        recordMode: 'recordContinuously', traceBufferSizeInKb: 16384,
        includedCategories: ['toplevel', 'devtools.timeline', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing']
      } });
    }, profileCpu);
    await page.evaluate(() => {
      let previous = performance.now();
      const data = { timeOrigin: performance.timeOrigin, maximumGapMs: 0, gaps: [] as { at: number; elapsedMs: number }[] };
      Reflect.set(window, '__nativeStabilityUi', data);
      const longFrames = { supported: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'), entries: [] as unknown[] };
      Reflect.set(window, '__nativeStabilityLongFrames', longFrames);
      if (longFrames.supported) {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) longFrames.entries.push(entry.toJSON());
          if (longFrames.entries.length > 200) longFrames.entries.splice(0, longFrames.entries.length - 200);
        });
        observer.observe({ type: 'long-animation-frame', buffered: true });
      }
      setInterval(() => { const now = performance.now(), gap = now - previous; previous = now;
        data.maximumGapMs = Math.max(data.maximumGapMs, gap);
        if (gap > 100 && data.gaps.length < 1000) {
          data.gaps.push({ at: now, elapsedMs: gap }); performance.mark('stability-ui-gap', { detail: { elapsedMs: gap } });
        }
      }, 5);
    });
    started = performance.now();
    const history: { itemId: string; positionMs: number; status: string; unreadySince: number | null }[] = [];
    for (let sample = 0; performance.now() - started < seconds * 1000; sample++) {
      const status = await page.evaluate(() => window.tbLink.getNativePlaybackStatus());
      const previous = history[0];
      expect(status).not.toBeNull();
      expect(status!.audioError).toBeNull(); expect(status!.underruns).toBe(0);
      expect(status!.mtcPortName).toBeNull(); expect(status!.mtcSent).toBe(0);
      expect(['playing', 'preparing', 'ready', 'ended']).toContain(status!.status);
      const item = project.rundown.find(item => item.id === status!.itemId);
      expect(item).toBeDefined(); expect(status!.offsetMs).toBe(item!.playback!.mtcOffsetMs);
      const unreadySince = status!.status === 'playing' ? null : previous?.itemId === status!.itemId ? previous.unreadySince ?? performance.now() : performance.now();
      if (unreadySince !== null && performance.now() - unreadySince >= 5000) throw new Error('自动换曲准备或结束状态持续超过 5 秒');
      if (previous?.itemId === status!.itemId && status!.status === 'playing') expect(status!.positionMs).toBeGreaterThan(previous.positionMs);
      if (previous && previous.itemId !== status!.itemId) {
        const previousIndex = project.rundown.findIndex(item => item.id === previous.itemId);
        expect(status!.itemId).toBe(project.rundown[previousIndex + 1]?.id);
      }
      visited.add(status!.itemId); history[0] = { itemId: status!.itemId, positionMs: status!.positionMs, status: status!.status, unreadySince };
      if (stressUi || sample % 3 === 0) {
        await page.evaluate(() => performance.mark('stability-editor-open'));
        await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
        await expect(page.locator('.timeline-ruler')).toBeVisible();
        await page.getByRole('textbox', { name: '搜索素材', exact: true }).fill('合成素材 100');
        await expect.poll(async () => {
          const names = await page.locator('.sidebar-editor .asset-row .media-name-cell strong').allTextContents();
          return names.length > 0 && names.every(name => name.includes('合成素材 100'));
        }).toBe(true);
        await page.getByRole('textbox', { name: '搜索素材', exact: true }).fill('');
        await expect.poll(async () => (await page.locator('.sidebar-editor .asset-row .media-name-cell strong').allTextContents())
          .some(name => !name.includes('合成素材 100'))).toBe(true);
        await page.evaluate(() => performance.mark('stability-editor-close'));
        await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
      }
      const responsiveness = await page.evaluate(() => Reflect.get(window, '__nativeStabilityUi') as { maximumGapMs: number; gaps: { at: number; elapsedMs: number }[] });
      const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
      const root = metrics.find(metric => metric.type === 'Browser');
      if (!root) throw new Error('Electron 主进程身份缺测');
      const processes = await measurePlaybackProcesses(root.pid, root.creationTime, status!.enginePid);
      measurements.samples++;
      measurements.maximumUiGapMs = Math.max(measurements.maximumUiGapMs, responsiveness.maximumGapMs);
      measurements.maximumProcessTreePrivateBytes = Math.max(measurements.maximumProcessTreePrivateBytes, processes.totalPrivateBytes);
      measurements.maximumUnderruns = Math.max(measurements.maximumUnderruns, status!.underruns);
      const evidence = { scope, engineSha256, elapsedMs: performance.now() - started, seconds, sample, status: { ...status, analysis: undefined }, responsiveness, visited: [...visited], errors, metrics, processes };
      await appendFile(info.outputPath('samples.ndjson'), `${JSON.stringify(evidence)}\n`);
      await writeFile(info.outputPath('progress.json'), JSON.stringify({ ...evidence, result: 'running' }, null, 2));
      expect(errors).toEqual([]);
      expect(responsiveness.maximumGapMs, '播放中出现超过100ms的UI间隔').toBeLessThanOrEqual(100);
      const privateBytes = metrics.reduce((sum, metric) => {
        if (metric.memory.privateBytes === undefined) throw new Error(`进程 ${metric.pid} 私有内存无法测量`);
        return sum + metric.memory.privateBytes * 1024;
      }, 0);
      expect(privateBytes).toBeLessThanOrEqual(2 * 1024 ** 3);
      expect(processes.totalPrivateBytes, '含原生音频与 FFmpeg 的应用进程树超过 2GiB').toBeLessThanOrEqual(2 * 1024 ** 3);
      await page.waitForTimeout(Math.min(stressUi ? 500 : 5000, Math.max(0, seconds * 1000 - (performance.now() - started))));
    }
    const final = await page.evaluate(async () => ({ status: await window.tbLink.getNativePlaybackStatus(),
      ui: Reflect.get(window, '__nativeStabilityUi') as { maximumGapMs: number } }));
    measurements.maximumUiGapMs = Math.max(measurements.maximumUiGapMs, final.ui.maximumGapMs);
    measurements.maximumUnderruns = Math.max(measurements.maximumUnderruns, final.status?.underruns ?? 0);
    expect(final.status?.audioError).toBeNull(); expect(final.status?.underruns).toBe(0);
    expect(final.ui.maximumGapMs, '末次等待期间的界面间隔也必须验收').toBeLessThanOrEqual(100);
    expect(errors).toEqual([]);
    expect(visited.size).toBeGreaterThanOrEqual(Math.min(200, Math.floor(seconds / 108) + 1));
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    // Freeze the Chromium ring before the slower ETW save can replace the failure window.
    try { await captureDiagnostics(); } catch (captureError) {
      errors.push(`保存浏览器失败窗口：${captureError instanceof Error ? captureError.message : String(captureError)}`);
    }
    // Opt-in only when this test coordinator owns the existing CPU memory
    // recording. Save on failure before the circular buffers age it out; the
    // independently running audio/MIDI process must continue uninterrupted.
    if (process.env.TBLINK_NATIVE_STABILITY_ROTATE_OWNED_WPR === '1') {
      const at = new Date().toISOString();
      try {
        await promisify(execFile)('wpr.exe', ['-stop', info.outputPath('failure-window.etl')], { windowsHide: true, timeout: 60000 });
        await promisify(execFile)('wpr.exe', ['-start', 'CPU'], { windowsHide: true, timeout: 10000 });
        await writeFile(info.outputPath('wpr-rotation.json'), JSON.stringify({ at, saved: true, subsequentMemoryWindowStarted: true,
          scope: '只保存失败附近的环形窗口；不是完整测试时段的CPU记录' }));
      } catch (captureError) {
        const message = captureError instanceof Error ? captureError.message : String(captureError);
        errors.push(`保存失败窗口：${message}`);
        await writeFile(info.outputPath('wpr-rotation.json'), JSON.stringify({ at, saved: false, error: message }));
      }
    }
    throw error;
  }
  finally {
    // Publish the primary outcome before optional tracing/cleanup, so a
    // renderer disconnect cannot erase the original failure evidence.
    await writeFile(info.outputPath('result.json'), JSON.stringify({ passed, failure, scope, engineSha256, seconds, elapsedMs: started ? performance.now() - started : 0, visited: [...visited], measurements, errors }, null, 2));
    if (!page.isClosed()) {
      const frames: unknown = await page.evaluate((): unknown => Reflect.get(window, '__nativeStabilityLongFrames'));
      if (frames) await writeFile(info.outputPath('long-animation-frames.json'), JSON.stringify(frames));
    }
    await captureDiagnostics();
    await writeFile(info.outputPath('result.json'), JSON.stringify({ passed, failure, scope, engineSha256, seconds, elapsedMs: started ? performance.now() - started : 0, visited: [...visited], measurements, errors }, null, 2));
    await page.evaluate(async () => { const state = await window.tbLink.getNativePlaybackStatus(); if (state) await window.tbLink.controlNativePlayback({ version: 1, sessionId: state.sessionId, generation: state.generation + 100, kind: 'stop' }); await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }); });
    await app.close();
  }
});
