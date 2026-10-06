import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseLinkProject } from '@tb/schema';
import { CueRuntime } from './cue-runtime';
import { frameNumberToTimecode, timecodeToFrameNumber } from './mtc-timecode';

it.skipIf(!process.env.TBLINK_CUE_BENCHMARK)('五万 Cue 调度基准：完整事件数量与逐帧耗时', async () => {
  const project = parseLinkProject({ schemaVersion: 1, projectId: 'load', name: '调度极限基准',
    createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', timebase: { frameRate: '30', mode: 'per-item-reset' },
    rundown: [{ id: 'program', title: '单节目五万 Cue（调度测试，不是实际输出验收）', cues: Array.from({ length: 50000 }, (_, index) => ({
      id: `cue-${index}`, name: `动作 ${index}`, timecode: frameNumberToTimecode(index, '30'), actions: [{ id: `action-${index}`, label: '验收场景', kind: 'obs.setProgramScene', sceneName: `验收机位 ${index % 16 + 1}` }]
    })) }] });
  const runtime = new CueRuntime(project);
  const started = performance.now();
  runtime.selectItem('program'); runtime.beginPreflight('live'); runtime.arm(0);
  const preparationMs = performance.now() - started;
  const timings: number[] = [];
  const nextTimings: number[] = [], previousNextTimings: number[] = [];
  const fired = new Set<string>();
  for (let frame = 0; frame < 600; frame++) {
    const before = performance.now();
    const result = runtime.ingest({ frameRate: '30', timecode: frameNumberToTimecode(frame, '30'), totalFrames: frame, receivedAtMs: frame * 1000 / 30, direction: 'forward' });
    timings.push(performance.now() - before);
    const nextBefore = performance.now();
    expect(runtime.getNextCueId()).toBe(`cue-${frame + 1}`);
    nextTimings.push(performance.now() - nextBefore);
    // Reproduce the removed UI calculation against the same program, without
    // reinstating this full scan/sort in production or using it to send output.
    const previousBefore = performance.now();
    const previousNext = project.rundown[0]!.cues.filter(cue => cue.enabled)
      .map(cue => ({ cue, frame: timecodeToFrameNumber(cue.timecode, '30') }))
      .filter(entry => entry.frame > frame).sort((a, b) => a.frame - b.frame)[0]?.cue.id;
    expect(previousNext).toBe(`cue-${frame + 1}`);
    previousNextTimings.push(performance.now() - previousBefore);
    expect(result.state).toBe('running');
    for (const due of result.dueCues) { expect(fired.has(due.cue.id)).toBe(false); fired.add(due.cue.id); }
  }
  expect(fired.size).toBe(600);
  timings.sort((a, b) => a - b);
  nextTimings.sort((a, b) => a - b); previousNextTimings.sort((a, b) => a - b);
  const directory = resolve('artifacts', `cue-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true });
  const report = { label: process.env.TBLINK_CUE_BENCHMARK, synthetic: true, realOutputAcceptance: false, cues: 50000, samples: 600,
    preparationMs, totalIngestMs: timings.reduce((a, b) => a + b, 0), p95IngestMs: timings[569], maximumIngestMs: timings.at(-1),
    nextCue: { p95Ms: nextTimings[569], maximumMs: nextTimings.at(-1) },
    previousFullScan: { p95Ms: previousNextTimings[569], maximumMs: previousNextTimings.at(-1) } };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.info(directory, report);
}, 120000);
