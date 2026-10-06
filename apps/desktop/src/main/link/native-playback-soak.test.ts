import { it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativePlaybackEvent } from '@tb/schema';
import { NativePlaybackClient } from './native-playback-client';

const portsSchema = z.object({ outputs: z.array(z.object({ id: z.number(), name: z.string() })), inputs: z.array(z.object({ id: z.number(), name: z.string() })) });
const measurementSchema = z.object({ qpc100ns: z.string().regex(/^\d+$/), timecodeMs: z.number(), broken: z.number(), overflow: z.number() }).strict();
type Clock = Extract<NativePlaybackEvent, { kind: 'clock' }>;
type Measurement = z.infer<typeof measurementSchema>;
const enabled = process.env.TBLINK_NATIVE_SOAK_SECONDS !== undefined;
const seconds = Number(process.env.TBLINK_NATIVE_SOAK_SECONDS ?? 60);

it.skipIf(!enabled)('原生 WASAPI / WinMM 独立回环：实际时钟误差、主进程阻塞与有界缓冲', async () => {
  expect(Number.isInteger(seconds) && seconds >= 30 && seconds <= 21600).toBe(true);
  const executable = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
  const probePath = join(dirname(executable), 'tblink-playback-probe.exe');
  const ports = portsSchema.parse(JSON.parse(execFileSync(probePath, ['--list'], { encoding: 'utf8', windowsHide: true })));
  const outputs = ports.outputs.filter(port => port.name === 'TBLINK SOAK MTC');
  const inputs = ports.inputs.filter(port => port.name === 'TBLINK SOAK MTC');
  expect(outputs).toHaveLength(1); expect(inputs).toHaveLength(1);
  const directory = resolve('artifacts', `native-soak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true });
  const engineSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
  const sources = ['tools/playback-engine/engine.c', 'tools/playback-engine/engine.h', 'tools/playback-engine/audio.c', 'tools/playback-engine/midi.c', 'tools/playback-engine/devices.c', 'tools/playback-engine/probe.c',
    'tools/playback-engine/signal.c', 'tools/playback-engine/signal.h', 'tools/playback-engine/signal-test.c',
    'tools/playback-engine/build.mjs', 'packages/schema/src/playback-engine.ts',
    'apps/desktop/src/main/link/native-playback-client.ts', 'apps/desktop/src/main/link/native-playback-protocol.ts', 'apps/desktop/src/main/link/native-playback-soak.test.ts'];
  await mkdir(join(directory, 'sources'));
  for (const source of sources) await copyFile(source, join(directory, 'sources', source.replaceAll('/', '__')));
  await copyFile(join(dirname(executable), 'build.json'), join(directory, 'sources', 'build.json'));
  const pcmPath = join(directory, 'silence.pcm');
  const pcm = await open(pcmPath, 'w');
  try { await pcm.truncate((seconds + 15) * 48000 * 4); } finally { await pcm.close(); }
  const trace = createWriteStream(join(directory, 'trace.ndjson'));
  const failures: string[] = [];
  trace.on('error', error => failures.push(`记录失败：${error.message}`));
  const clocks: Clock[] = [];
  const pending: Measurement[] = [];
  // Fixed histogram and bounded join window keep a six-hour run from retaining
  // every 50 ms snapshot in memory. Raw evidence is streamed to disk.
  const histogram = new Uint32Array(10001);
  let samples = 0, minimum = Infinity, maximum = -Infinity, broken = 0, overflow = 0;
  let maximumUnderruns = 0, maximumMidiLateness = 0, maximumBuffered = 0, unmatched = 0;
  let firstError = 0, lastError = 0;
  let midiTiming: Clock['midiTiming'];
  let lastTimecode: number | null = null, discontinuousCycles = 0;
  const compare = (): void => {
    while (pending.length && clocks.length) {
      const sample = pending[0]!;
      const qpc = Number(sample.qpc100ns);
      if (qpc > Number(clocks.at(-1)!.qpc100ns)) break;
      pending.shift();
      const nearest = clocks.reduce((a, b) => Math.abs(Number(a.qpc100ns) - qpc) < Math.abs(Number(b.qpc100ns) - qpc) ? a : b);
      if (Math.abs(Number(nearest.qpc100ns) - qpc) > 1_000_000) { unmatched++; continue; }
      const expected = 480000 + nearest.positionMs + (qpc - Number(nearest.qpc100ns)) / 10000;
      // Receiver includes standard +2-frame compensation. Also retain its raw
      // value; the quarter-frame boundary itself is NOT subtracted to hide error.
      const error = sample.timecodeMs - expected;
      if (!samples) firstError = error;
      lastError = error; samples++; minimum = Math.min(minimum, error); maximum = Math.max(maximum, error);
      histogram[Math.min(10000, Math.round(Math.abs(error) * 100))]!++;
      trace.write(`${JSON.stringify({ kind: 'comparison', ...sample, expectedMs: expected, errorMs: error })}\n`);
    }
    if (pending.length > 256) { failures.push('回环对齐队列超过容量'); pending.splice(0); }
  };
  const client = new NativePlaybackClient(executable, event => {
    trace.write(`${JSON.stringify(event)}\n`);
    if (event.kind !== 'clock') return;
    midiTiming = event.midiTiming;
    maximumUnderruns = Math.max(maximumUnderruns, event.underruns);
    maximumMidiLateness = Math.max(maximumMidiLateness, event.maxMidiLatenessMs);
    maximumBuffered = Math.max(maximumBuffered, event.bufferedFrames);
    if (event.audioError || event.midiError) {
      const reason = `引擎通道失败：audio=${event.audioError}, midi=${event.midiError}`;
      if (!failures.includes(reason)) failures.push(reason);
    }
    if (event.state === 'playing' && event.qpc100ns !== '0') {
      clocks.push(event); if (clocks.length > 128) clocks.shift(); compare();
    }
  }, error => failures.push(error.message));
  // Receiver starts before prepare/play; leave room for setup and the stop boundary.
  const probe = spawn(probePath, [String(inputs[0]!.id), String(seconds + 8)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(probe, 'close');
  let probeClosed = false;
  probe.on('close', code => { probeClosed = true; if (code !== 0) failures.push(`回环探针退出：${code}`); });
  let buffer = '', ready = false;
  probe.stdout.setEncoding('utf8');
  probe.stderr.on('data', (value: Buffer) => failures.push(value.toString('utf8')));
  probe.on('error', error => failures.push(error.message));
  probe.stdout.on('data', (data: string) => {
    buffer += data;
    if (buffer.length > 65536) { failures.push('回环探针响应超过容量'); buffer = ''; return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const value: unknown = JSON.parse(line);
        if (z.object({ ready: z.literal(true) }).strict().safeParse(value).success) { ready = true; continue; }
        const measurement = measurementSchema.parse(value);
        if (lastTimecode !== null && Math.abs(measurement.timecodeMs - lastTimecode - 2000 / 30) > 0.001) discontinuousCycles++;
        lastTimecode = measurement.timecodeMs;
        trace.write(`${JSON.stringify({ kind: 'received', ...measurement })}\n`);
        broken = Math.max(broken, measurement.broken); overflow = Math.max(overflow, measurement.overflow);
        pending.push(measurement); compare();
      } catch (error) { failures.push(String(error)); }
    }
  });
  let hostBlocks = 0, startedAt: number | null = null;
  try {
    await expect.poll(() => ready, { timeout: 5000 }).toBe(true);
    await client.start();
    await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath, sampleRate: 48000, frameRate: 30, midiDevice: outputs[0]!.id, startMs: 1500, endMs: (seconds + 12) * 1000, offsetMs: 480000, volume: 1 });
    await client.command({ protocol: 4, requestId: 2, generation: 2, kind: 'play' });
    const started = performance.now(), end = started + seconds * 1000;
    startedAt = started;
    let nextProgress = started;
    let nextBlock = performance.now() + 5000;
    while (performance.now() < end && !failures.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (performance.now() >= nextProgress) {
        await writeFile(join(directory, 'progress.json'), JSON.stringify({ status: 'running', seconds,
          elapsedMs: performance.now() - started, samples, minimumErrorMs: minimum, maximumErrorMs: maximum,
          maximumUnderruns, broken, overflow, discontinuousCycles, hostBlocks, failures,
          physicalConsoleAcceptance: false, productionPlayerAcceptance: false }, null, 2));
        nextProgress = performance.now() + 10000;
      }
      if (performance.now() >= nextBlock) {
        // Deliberately freeze the controlling JS thread for one second. Both the
        // engine and receiver run in native processes and timestamp independently.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        hostBlocks++; nextBlock = performance.now() + 5000;
      }
    }
    await client.command({ protocol: 4, requestId: 3, generation: 3, kind: 'pause' });
    await new Promise(resolve => setTimeout(resolve, 200));
  } catch (error) { failures.push(String(error)); }
  finally {
    try { await client.close(); } catch (error) { failures.push(`引擎清理失败：${String(error)}`); }
    if (!probeClosed) probe.stdin.end();
    await exited;
    trace.end(); await once(trace, 'close');
    const target = Math.ceil(samples * 0.99);
    let accumulated = 0, p99 = 0;
    for (let i = 0; i < histogram.length; i++) { accumulated += histogram[i]!; if (accumulated >= target) { p99 = i / 100; break; } }
    if (engineSha256 !== createHash('sha256').update(await readFile(executable)).digest('hex')) failures.push('测试期间引擎文件改变');
    const report = { seconds, elapsedMs: startedAt === null ? 0 : performance.now() - startedAt, engineSha256, midiTiming,
      physicalConsoleAcceptance: false, audibleOutputAcceptance: false, source: 'raw PCM silence, WASAPI default output + dedicated WinMM loopMIDI',
      samples, minimumErrorMs: minimum, maximumErrorMs: maximum, p99AbsoluteErrorMs: p99, firstErrorMs: firstError, lastErrorMs: lastError,
      maximumUnderruns, maximumMidiLatenessMs: maximumMidiLateness, maximumBufferedFrames: maximumBuffered, broken, overflow, unmatched,
      unmatchedAtStop: pending.length, discontinuousCycles, hostBlocks, failures };
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(directory, 'progress.json'), JSON.stringify({ ...report, status: failures.length ? 'failed' : 'finished',
      validation: '最终结论以测试断言退出结果为准' }, null, 2));
    console.info(`原生回环报告：${directory}`, report);
    expect(failures).toEqual([]); expect(maximumUnderruns).toBe(0); expect(broken).toBe(0); expect(overflow).toBe(0);
    expect(discontinuousCycles).toBe(0);
    expect(unmatched).toBe(0); expect(pending.length).toBeLessThanOrEqual(2);
    expect(samples).toBeGreaterThan(seconds * 14); expect(hostBlocks).toBeGreaterThan(0);
    expect(Math.max(Math.abs(minimum), Math.abs(maximum))).toBeLessThanOrEqual(1000 / 30);
    expect(p99).toBeLessThanOrEqual(10); expect(maximumBuffered).toBeLessThanOrEqual(262144);
  }
}, (seconds + 25) * 1000);
