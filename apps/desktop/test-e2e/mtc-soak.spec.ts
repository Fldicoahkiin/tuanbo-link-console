import { test, expect, _electron as electron } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

test('真实媒体时钟与 Windows MIDI 回环持续测量', async ({}, info) => {
  test.skip(!process.env.TBLINK_MTC_SOAK, '需要专用 Windows MIDI 回环端口');
  const internal = process.env.TBLINK_MTC_SOAK_INTERNAL === '1';
  const seconds = Number(process.env.TBLINK_MTC_SOAK_SECONDS ?? 3600);
  const offsetMs = Number(process.env.TBLINK_MTC_SOAK_OFFSET_MS ?? 0);
  const waveformCached = Boolean(process.env.TBLINK_MTC_SOAK_CACHED);
  const audioSeconds = Number(process.env.TBLINK_MTC_SOAK_AUDIO_SECONDS ?? seconds + 5);
  if (!Number.isInteger(audioSeconds) || audioSeconds < seconds + 5 || audioSeconds > 86400) throw new Error('测试音频必须覆盖测量时长且不超过 24 小时');
  const inputName = process.env.TBLINK_MTC_SOAK_INPUT ?? 'TBLINK SOAK MTC';
  const outputName = process.env.TBLINK_MTC_SOAK_OUTPUT ?? 'TBLINK SOAK MTC';
  if (!inputName.startsWith('TBLINK SOAK ') || !outputName.startsWith('TBLINK SOAK ')) throw new Error('测量只能使用专用端口');
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 21600) throw new Error('测量时长必须为 10–21600 秒');
  if (!Number.isInteger(offsetMs) || offsetMs < 0 || offsetMs + audioSeconds * 1000 >= 86400000 || (!internal && offsetMs !== 0)) throw new Error('原始偏移必须适用于内部播放器，且整段音频不能跨过 24 小时');
  test.setTimeout((seconds + 90) * 1000);
  await writeFile(info.outputPath('configuration.json'), JSON.stringify({ internal, seconds, audioSeconds, offsetMs, inputName, outputName, waveformCached,
    buildDirectory: process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', platform: process.platform,
    forcedGarbageCollection: Boolean(process.env.TBLINK_MTC_SOAK_GC), concurrentPortLifecycle: Boolean(process.env.TBLINK_MTC_SOAK_PEER),
    mainSha256: createHash('sha256').update(await readFile(join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs'))).digest('hex'),
    rendererHtmlSha256: createHash('sha256').update(await readFile(join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'renderer/index.html'))).digest('hex'),
    physicalConsoleAcceptance: false }, null, 2));
  const application = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
  const page = await application.firstWindow();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    const samples = audioSeconds * 8000;
    const wav = Buffer.alloc(44 + samples, 128);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
    wav.write('data', 36); wav.writeUInt32LE(samples, 40);
    await mkdir(info.outputPath('assets/reference-audio'), { recursive: true });
    const audioPath = info.outputPath('assets/reference-audio/clock.wav'); await writeFile(audioPath, wav);
    const lighting = createLightingDocument();
    lighting.tracks = [{ id: 'track', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '测量', start: 0, duration: audioSeconds * 1000, timeLock: 'time', muted: false, events: [] }] }];
    const project = createEmptyLinkProject('MTC 独立持续测量'); project.schemaVersion = 2; if (internal) project.playbackSource = 'internal';
    project.rundown.push({ id: 'song', title: '真实媒体时钟', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting,
      playback: { volume: 100, startMs: 0, endMs: audioSeconds * 1000, mtcOffsetMs: offsetMs, endAction: 'stop', shortcut: '' },
      referenceAudio: { assetId: 'audio', relativePath: 'assets/reference-audio/clock.wav', durationMs: audioSeconds * 1000, sha256: createHash('sha256').update(await readFile(audioPath)).digest('hex') } });
    const projectPath = info.outputPath('clock.tblink'); await writeFile(projectPath, JSON.stringify(project));
    const profile = createDefaultIntegrationProfile();
    profile.midiPortProfiles.push({ id: 'soak-mtc', direction: 'output', portName: outputName });
    profile.internalPlayer = { mtcOutputPortProfileId: 'soak-mtc', audioOutputDeviceId: 'default' };
    await page.evaluate((value) => window.tbLink.saveIntegrationProfile({ profile: value }), profile);
    await page.addInitScript(() => {
      const originalPlay = Reflect.get(HTMLMediaElement.prototype, 'play') as (this: HTMLMediaElement) => Promise<void>;
      HTMLMediaElement.prototype.play = function(): Promise<void> { Reflect.set(window, '__mtcSoakAudio', this); return originalPlay.call(this); };
      const timings: { operation: string; duration: number }[] = [];
      Reflect.set(window, '__mtcSoakTimings', timings);
      let previous = performance.now();
      setInterval(() => {
        const now = performance.now();
        if (now - previous > 50 && timings.length < 1000) timings.push({ operation: 'timer-gap', duration: now - previous });
        previous = now;
      }, 5);
      const getChannelData = Reflect.get(AudioBuffer.prototype, 'getChannelData') as (this: AudioBuffer, channel: number) => Float32Array<ArrayBuffer>;
      AudioBuffer.prototype.getChannelData = function(channel: number): Float32Array<ArrayBuffer> {
        const start = performance.now();
        const result = getChannelData.call(this, channel);
        timings.push({ operation: 'getChannelData', duration: performance.now() - start });
        return result;
      };
      const observer = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          if (timings.length < 1000) timings.push({ operation: entry.entryType, duration: entry.duration });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    });
    await page.reload();
    if (process.env.TBLINK_MTC_SOAK_PROFILE) await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.debugger.attach('1.3');
      await contents.debugger.sendCommand('Profiler.enable');
      await contents.debugger.sendCommand('Profiler.start');
      await contents.debugger.sendCommand('Performance.enable');
    });
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] }); }, projectPath);
    // The cache is written for the project the window shows; showing it before the reload would reopen it as the last project.
    if (waveformCached) {
      await page.getByRole('button', { name: '打开工程', exact: true }).waitFor();
      await page.evaluate(() => window.tbLink.pickProjectDocument());
      await page.evaluate(path => window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: path, projectId: null }), projectPath);
      await page.evaluate(({ projectPath, sha256 }) => window.tbLink.saveWaveformCache({ projectPath, sha256, peaks: Array.from({ length: 2400 }, () => 0) }), { projectPath, sha256: project.rundown[0]!.referenceAudio!.sha256 });
    }
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    if (!internal) {
      await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
      await expect.poll(() => page.locator('.timeline-toolbar > audio').evaluate((element) => (element as HTMLAudioElement).readyState)).toBeGreaterThanOrEqual(2);
    }
    await page.evaluate(async ({ inputName, outputName, offsetMs }) => {
      const access = await navigator.requestMIDIAccess({ sysex: true });
      const inputs = [...access.inputs.values()].filter((port) => port.name === inputName && port.state === 'connected');
      if (inputs.length !== 1 || !inputs[0]) throw new Error('专用测量输入未连接或不唯一');
      const input = inputs[0]; await input.open();
      Reflect.set(window, '__mtcSoakAccess', access);
      const output = [...access.outputs.values()].find((port) => port.name === outputName);
      if (!output) throw new Error('专用测量输出不存在');
      const prototype = Object.getPrototypeOf(output) as MIDIOutput;
      const send = Reflect.get(prototype, 'send') as (this: MIDIOutput, data: number[] | Uint8Array, timestamp?: number) => void;
      const sent = { count: 0, name: '', status: 0, matched: 0, mismatches: 0, pending: [] as number[][] }; Reflect.set(window, '__mtcSoakSent', sent);
      const pendingTimes: { at: number; mediaMs: number }[] = [];
      const delivery = { minimumSendErrorMs: Infinity, maximumSendErrorMs: -Infinity, maximumCallbackDelayMs: 0, anomalies: [] as { errorMs: number; sendErrorMs: number; arrivalErrorMs: number; callbackDelayMs: number }[] };
      Reflect.set(window, '__mtcSoakDelivery', delivery);
      prototype.send = function(this: MIDIOutput, data: number[] | Uint8Array, timestamp?: number): void {
        if (this.name !== outputName) { send.call(this, data, timestamp); return; }
        sent.count += 1; sent.name = this.name ?? ''; sent.status = data[0] ?? 0;
        if (sent.pending.length < 1024) sent.pending.push([...data]);
        else throw new Error('MIDI 回环待核对消息超过上限');
        pendingTimes.push({ at: performance.now(), mediaMs: ((Reflect.get(window, '__mtcSoakAudio') as HTMLAudioElement | undefined)?.currentTime ?? 0) * 1000 });
        Reflect.set(window, '__mtcSoakOutput', this);
        const start = performance.now(); send.call(this, data, timestamp);
        if (performance.now() - start > 50) (Reflect.get(window, '__mtcSoakTimings') as { operation: string; duration: number }[]).push({ operation: 'native-send', duration: performance.now() - start });
      };
      const stats = { cycles: 0, brokenSequences: 0, minimum: Infinity, maximum: -Infinity, first: [] as number[], recent: [] as number[], lastMediaMs: 0 };
      const histogram = new Uint32Array(10001);
      Reflect.set(window, '__mtcSoakHistogram', histogram);
      Reflect.set(window, '__mtcSoakStats', stats); Reflect.set(window, '__mtcSoakInput', input);
      const values: number[] = []; let expected = 0;
      const received = { count: 0, status: 0, recent: [] as number[][] }; Reflect.set(window, '__mtcSoakReceived', received);
      input.onmidimessage = (message) => {
        const bytes = message.data; received.count += 1; received.status = bytes?.[0] ?? 0;
        const expectedBytes = sent.pending.shift();
        const emission = pendingTimes.shift();
        if (bytes && expectedBytes && bytes.length === expectedBytes.length && expectedBytes.every((value, index) => bytes[index] === value)) sent.matched += 1;
        else sent.mismatches += 1;
        received.recent.push(bytes ? [...bytes] : []); if (received.recent.length > 32) received.recent.shift();
        if (!bytes || bytes[0] !== 0xf1) return;
        const piece = (bytes[1]! >> 4) & 7;
        if (piece !== expected) { stats.brokenSequences += 1; expected = 0; if (piece !== 0) return; }
        values[piece] = bytes[1]! & 15; expected = (piece + 1) % 8;
        if (piece !== 7) return;
        const audio = (Reflect.get(window, '__mtcSoakAudio') as HTMLAudioElement | undefined); if (!audio) throw new Error('音频时钟缺失');
        const frames = values[0]! + ((values[1]! & 1) << 4);
        const sec = values[2]! + ((values[3]! & 3) << 4);
        const min = values[4]! + ((values[5]! & 3) << 4);
        const hour = values[6]! + ((values[7]! & 1) << 4);
        // Standard forward quarter-frame assembly is two frames behind the running time.
        const error = ((hour * 3600 + min * 60 + sec) * 30 + frames + 2) * 1000 / 30 - audio.currentTime * 1000 - offsetMs;
        histogram[Math.min(10000, Math.round(Math.abs(error) * 100))]! += 1;
        // Keep the original end-to-end limit. These additional samples separate
        // a late sender from an input callback delayed on the renderer thread.
        const callbackDelayMs = performance.now() - message.timeStamp;
        delivery.maximumCallbackDelayMs = Math.max(delivery.maximumCallbackDelayMs, callbackDelayMs);
        if (emission) {
          const sendErrorMs = ((hour * 3600 + min * 60 + sec) * 30 + frames + 2) * 1000 / 30 - emission.mediaMs - offsetMs;
          delivery.minimumSendErrorMs = Math.min(delivery.minimumSendErrorMs, sendErrorMs);
          delivery.maximumSendErrorMs = Math.max(delivery.maximumSendErrorMs, sendErrorMs);
          if (Math.abs(error) > 1000 / 30 && delivery.anomalies.length < 100) delivery.anomalies.push({ errorMs: error, sendErrorMs, arrivalErrorMs: sendErrorMs - (message.timeStamp - emission.at), callbackDelayMs });
        }
        stats.cycles += 1; stats.minimum = Math.min(stats.minimum, error); stats.maximum = Math.max(stats.maximum, error);
        if (stats.first.length < 150) stats.first.push(error);
        stats.recent.push(error); if (stats.recent.length > 150) stats.recent.shift();
        stats.lastMediaMs = audio.currentTime * 1000;
      };
      await output.open();
      // One bounded challenge, never retransmitted. A/B native loopbacks need
      // opposite endpoints; connected/open alone does not prove routing.
      for (let value = 1; value <= 8; value += 1) output.send([0xb0, 119, value]);
    }, { inputName, outputName, offsetMs });
    await page.waitForTimeout(300);
    const route = await page.evaluate(() => Reflect.get(window, '__mtcSoakSent') as { count: number; matched: number; mismatches: number; pending: number[][] });
    await writeFile(info.outputPath('route.json'), JSON.stringify(route, null, 2));
    if (route.matched !== 8 || route.mismatches !== 0 || route.pending.length !== 0) throw new Error('MIDI 回环路由预检失败：测试字节未完整返回；请核对 A/B 配对或 Windows MIDI 驱动，尚未开始播放');
    if (internal) {
      await page.locator('.player-transport .primary-button').click();
      await expect(page.locator('.player-transport.status-playing')).toBeVisible();
    } else {
      await page.locator('.lighting-track-name').click();
      await page.getByLabel('灯光播放方式').selectOption('linked');
      await expect(page.getByLabel('灯光播放方式')).toHaveValue('linked');
      await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    }
    const started = Date.now(); let phase = 0; let collected = false; let peerClosed = false;
    const resources: { elapsedMs: number; workingSetKiB: number; privateKiB: number; cpuPercent: number }[] = [];
    while (Date.now() - started < seconds * 1000) {
      await page.waitForTimeout(1000);
      if (!resources.length || Date.now() - started - resources.at(-1)!.elapsedMs >= 10000) {
        const usage = await application.evaluate(({ app }) => app.getAppMetrics().reduce((sum, process) => ({
          workingSetKiB: sum.workingSetKiB + process.memory.workingSetSize,
          privateKiB: sum.privateKiB + (process.memory.privateBytes ?? 0),
          cpuPercent: sum.cpuPercent + process.cpu.percentCPUUsage
        }), { workingSetKiB: 0, privateKiB: 0, cpuPercent: 0 }));
        resources.push({ elapsedMs: Date.now() - started, ...usage });
        await writeFile(info.outputPath('resources.json'), JSON.stringify(resources, null, 2));
      }
      const state = await page.evaluate(() => ({ stats: Reflect.get(window, '__mtcSoakStats') as { cycles: number; brokenSequences: number; minimum: number; maximum: number; first: number[]; recent: number[]; lastMediaMs: number }, paused: (Reflect.get(window, '__mtcSoakAudio') as HTMLAudioElement | undefined)?.paused, mediaMs: ((Reflect.get(window, '__mtcSoakAudio') as HTMLAudioElement | undefined)?.currentTime ?? 0) * 1000, mode: document.querySelector<HTMLSelectElement>('[aria-label="灯光播放方式"]')?.value, inputConnection: (Reflect.get(window, '__mtcSoakInput') as MIDIInput).connection, notices: [...document.querySelectorAll('.toast, .player-notice')].map((element) => element.textContent) }));
      await writeFile(info.outputPath('progress.json'), JSON.stringify({ elapsedMs: Date.now() - started, ...state }, null, 2));
      await writeFile(info.outputPath('sent.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__mtcSoakSent') as { count: number; name: string; status: number }), null, 2));
      await writeFile(info.outputPath('received.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__mtcSoakReceived') as { count: number; status: number }), null, 2));
      await writeFile(info.outputPath('timings.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__mtcSoakTimings') as { operation: string; duration: number }[]), null, 2));
      await writeFile(info.outputPath('delivery.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, '__mtcSoakDelivery') as unknown), null, 2));
      if (state.stats.cycles > 0 && Math.max(Math.abs(state.stats.minimum), Math.abs(state.stats.maximum)) > 1000 / 30) throw new Error('实际回环误差超过一帧，停止本次验收；详见 delivery.json');
      if (state.paused) throw new Error('测量期间播放意外停止，请检查 progress.json');
      const mismatches = await page.evaluate(() => (Reflect.get(window, '__mtcSoakSent') as { mismatches: number }).mismatches);
      if (mismatches) throw new Error('MIDI 实收字节与发送字节不一致，请检查 sent.json 和 received.json');
      if (state.mediaMs - state.stats.lastMediaMs > 1000) throw new Error('实际 MIDI 接收已中断超过一秒，请检查发送计数和端口状态');
      if (process.env.TBLINK_MTC_SOAK_PEER && !peerClosed && Date.now() - started > seconds * 1000 / 6) {
        const peer = await electron.launch({ args: [`--user-data-dir=${info.outputPath('peer-profile')}`, join(process.cwd(), process.env.TBLINK_MTC_SOAK_BUILD_DIR ?? 'out', 'main/index.cjs')] });
        try {
          const peerPage = await peer.firstWindow();
          await peerPage.evaluate(async ({ inputName, outputName }) => {
            const access = await navigator.requestMIDIAccess({ sysex: true });
            Reflect.set(window, '__peerAccess', access);
            const input = [...access.inputs.values()].find((port) => port.name === inputName);
            const output = [...access.outputs.values()].find((port) => port.name === outputName);
            if (!input || !output) throw new Error('并发测试端口缺失');
            await input.open(); await output.open();
            await input.close(); await output.close();
          }, { inputName, outputName });
        } finally { await peer.close(); }
        peerClosed = true;
      }
      if (process.env.TBLINK_MTC_SOAK_GC && !collected && Date.now() - started > seconds * 1000 / 6) {
        await application.evaluate(async ({ BrowserWindow }) => {
          const contents = BrowserWindow.getAllWindows()[0]!.webContents;
          const attached = contents.debugger.isAttached();
          if (!attached) contents.debugger.attach('1.3');
          try { await contents.debugger.sendCommand('HeapProfiler.collectGarbage'); }
          finally { if (!attached) contents.debugger.detach(); }
        });
        collected = true;
      }
      if (phase === 0 && Date.now() - started > seconds * 1000 / 3) { await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize()); phase = 1; }
      if (phase === 1 && Date.now() - started > seconds * 2000 / 3) { await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore()); phase = 2; }
    }
    const report = JSON.parse(await readFile(info.outputPath('progress.json'), 'utf8')) as { stats: { cycles: number; brokenSequences: number; minimum: number; maximum: number; first: number[]; recent: number[]; lastMediaMs: number } };
    const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
    const driftMs = mean(report.stats.recent) - mean(report.stats.first);
    const histogram = await page.evaluate(() => Array.from(Reflect.get(window, '__mtcSoakHistogram') as Uint32Array));
    const target = Math.ceil(report.stats.cycles * 0.99);
    let accumulated = 0, p99AbsoluteErrorMs = 0;
    for (const [index, count] of histogram.entries()) { accumulated += count; if (accumulated >= target) { p99AbsoluteErrorMs = index / 100; break; } }
    await writeFile(info.outputPath('result.json'), JSON.stringify({ seconds, inputName, outputName, waveformCached, audioSeconds, offsetMs, collected, peerClosed, transport: 'Windows MIDI loopback', frameRate: 30, driftMs, p99AbsoluteErrorMs, ...report }, null, 2));
    expect(report.stats.cycles).toBeGreaterThan(seconds * 14);
    expect(report.stats.brokenSequences).toBe(0);
    expect(Math.abs(driftMs)).toBeLessThanOrEqual(1000 / 30);
    expect(p99AbsoluteErrorMs).toBeLessThanOrEqual(10);
    expect(Math.max(Math.abs(report.stats.minimum), Math.abs(report.stats.maximum))).toBeLessThanOrEqual(1000 / 30);
    // Close the actual production sender, not the independently opened probe.
    // The player must fail once instead of Web MIDI implicitly reopening it.
    await page.evaluate(async () => { await (Reflect.get(window, '__mtcSoakOutput') as MIDIOutput).close(); });
    await expect.poll(() => page.evaluate(() => (Reflect.get(window, '__mtcSoakAudio') as HTMLAudioElement).paused)).toBe(!internal);
    await expect.poll(() => page.locator('.toast, .player-notice').allTextContents()).toContainEqual(expect.stringContaining('连接失效'));
    const stopped = await page.evaluate(() => ({ count: (Reflect.get(window, '__mtcSoakSent') as { count: number }).count,
      connection: (Reflect.get(window, '__mtcSoakOutput') as MIDIOutput).connection,
      notices: [...document.querySelectorAll('.toast, .player-notice')].map(element => element.textContent) }));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (Reflect.get(window, '__mtcSoakSent') as { count: number }).count)).toBe(stopped.count);
    expect(stopped.connection).toBe('closed');
    expect(stopped.notices.join(' ')).toContain('连接失效');
    await writeFile(info.outputPath('disconnect.json'), JSON.stringify(stopped, null, 2));
    expect(pageErrors).toEqual([]);
    await writeFile(info.outputPath('acceptance.json'), JSON.stringify({ internal, passed: true, physicalConsoleAcceptance: false, seconds, checked: ['route', 'byte-order', 'quarter-frame-order', 'drift', 'one-frame-error', 'disconnect-no-reopen', 'page-errors'] }, null, 2));
  } catch (error) {
    await writeFile(info.outputPath('failure.json'), JSON.stringify({ passed: false, physicalConsoleAcceptance: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    throw error;
  } finally {
    await writeFile(info.outputPath('page-errors.json'), JSON.stringify(pageErrors, null, 2));
    const cpu = await application.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      if (!contents.debugger.isAttached()) return null;
      const result: unknown = await contents.debugger.sendCommand('Profiler.stop');
      const metrics: unknown = await contents.debugger.sendCommand('Performance.getMetrics');
      contents.debugger.detach();
      return { cpu: result, metrics };
    });
    await writeFile(info.outputPath('renderer.cpuprofile'), JSON.stringify(cpu));
    await page.evaluate(async () => { (Reflect.get(window, '__mtcSoakAudio') as HTMLAudioElement | undefined)?.pause(); const input = Reflect.get(window, '__mtcSoakInput') as MIDIInput | undefined; if (input) { input.onmidimessage = null; await input.close(); } await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentState({ version: 1, dirty: false, consoleSynced: false, name: null, projectPath: null, projectId: null }); });
    await application.close();
  }
});

