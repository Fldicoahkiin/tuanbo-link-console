import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// CPU-only measurement, never connects to OBS or sends lighting commands.
const fixture = resolve(process.argv[2] ?? 'artifacts/stability-fixture-9QPbsu/mixed/stability.tblink');
const directory = resolve(process.argv[3] ?? `artifacts/scene-index-${Date.now()}`);
await mkdir(directory, { recursive: true });
const bundle = join(directory, 'domain.cjs');
await build({ stdin: { contents: "export { SceneOutputTimeline } from './packages/core/src/scene-output-timeline'; export { parseLinkProject } from './packages/schema/src/index'; export { frameNumberToTimecode } from './packages/core/src/mtc-timecode';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@tb/schema': resolve('packages/schema/src/index.ts') }, outfile: bundle });
const { SceneOutputTimeline, parseLinkProject, frameNumberToTimecode } = createRequire(import.meta.url)(bundle);
const reference = process.argv[4] ? createRequire(import.meta.url)(resolve(process.argv[4])) : null;
const contents = await readFile(fixture);
const project = parseLinkProject(JSON.parse(contents.toString('utf8')));
function measure(project, itemId) {
  const begin = performance.now();
  const timeline = new SceneOutputTimeline(project, itemId);
  const constructed = performance.now();
  const entries = timeline.preloadEntries();
  const prepared = performance.now();
  for (let frame = 0; frame < 30000; frame += 30) timeline.at(frame);
  const result = { constructMs: constructed - begin, preloadMs: prepared - constructed, thousandQueriesMs: performance.now() - prepared, entries: entries.length };
  if (reference) {
    const previous = new reference.SceneOutputTimeline(project, itemId);
    assert.deepEqual(entries, previous.preloadEntries());
    const stable = work => ({ media: work.media, cues: work.cues.map(entry => ({ scheduledFrame: entry.scheduledFrame, cue: entry.cue })) });
    // Deliberately query backward as well as forward; an advancing-only cursor
    // is insufficient for user seeks and preflight inspection.
    for (let index = 0; index < 1000; index++) {
      const frame = (index * 7919) % 30000;
      assert.deepEqual(stable(timeline.at(frame)), stable(previous.at(frame)));
    }
  }
  return result;
}
const rows = project.rundown.map(item => ({ itemId: item.id, ...measure(project, item.id) }));
const dense = [];
for (const count of [250, 2000, 10000]) {
  const base = project.rundown[0], clip = base.referenceMediaClips[0];
  const item = { ...base, cues: [], referenceMediaClips: Array.from({ length: count }, (_, index) => ({ ...clip,
    id: `cpu-clip-${index}`, startTimecode: frameNumberToTimecode(index * 30, project.timebase.frameRate), durationMs: 1000 })) };
  dense.push({ syntheticClipsInOneProgram: count, ...measure({ ...project, rundown: [item] }, item.id) });
}
const report = { fixture, fixtureSha256: createHash('sha256').update(contents).digest('hex'), bundleSha256: createHash('sha256').update(await readFile(bundle)).digest('hex'),
  measuredAt: new Date().toISOString(), comparedToPreviousImplementation: Boolean(reference), scope: 'CPU index only; no audio, video or hardware acceptance', programs: project.rundown.length,
  assets: project.mediaAssets.length, cues: project.rundown.reduce((sum, item) => sum + item.cues.length, 0), rows, dense };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, programs: report.programs, dense, programTotals: rows.reduce((sum, row) => ({ constructMs: sum.constructMs + row.constructMs,
  preloadMs: sum.preloadMs + row.preloadMs, thousandQueriesMs: sum.thousandQueriesMs + row.thousandQueriesMs }), { constructMs: 0, preloadMs: 0, thousandQueriesMs: 0 }) }, null, 2));
