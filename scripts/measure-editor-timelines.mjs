import { build } from 'esbuild';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const fixture = process.argv[2];
if (!fixture) throw new Error('用法：node scripts/measure-editor-timelines.mjs <tblink>');
const root = resolve('artifacts'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'editor-timeline-measurement-'));
const modulePath = join(directory, 'timeline.mjs');
await build({ stdin: { contents: "export { SceneOutputTimeline, sceneOutputAt } from './packages/core/src/scene-output-timeline'; export { parseLinkProject } from '@tb/schema';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: modulePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { SceneOutputTimeline, sceneOutputAt, parseLinkProject } = await import(pathToFileURL(modulePath).href);
const project = parseLinkProject(JSON.parse(await readFile(resolve(fixture), 'utf8')));
assert.equal(project.rundown.length, 200); assert.equal(project.mediaAssets.length, 2000);
const semantic = output => ({ cues: output.cues.map(({ cue, scheduledFrame }) => ({ cue, scheduledFrame })), media: output.media });
const frames = Array.from({ length: 60 }, (_, index) => index * 45);
const mismatches = [];
for (const item of project.rundown) {
  const timeline = new SceneOutputTimeline(project, item.id);
  for (const frame of frames) {
    try { assert.deepEqual(semantic(timeline.at(frame)), semantic(sceneOutputAt(project, item.id, frame))); }
    catch (error) { mismatches.push({ itemId: item.id, frame, message: String(error) }); }
  }
}
const rounds = [];
for (let round = 0; round < 3; round++) {
  for (const cached of round % 2 ? [true, false] : [false, true]) {
    let checksum = 0;
    const started = performance.now();
    for (const item of project.rundown) {
      const timeline = cached ? new SceneOutputTimeline(project, item.id) : null;
      for (const frame of frames) {
        const output = timeline ? timeline.at(frame) : sceneOutputAt(project, item.id, frame);
        checksum += output.cues.length + output.media.length;
      }
    }
    rounds.push({ round, cached, elapsedMs: performance.now() - started, checksum });
  }
}
const report = { scope: '编辑器场景解析函数实测，不代表 Electron 交互、视频输出或六小时验收',
  fixture: resolve(fixture), programs: project.rundown.length, assets: project.mediaAssets.length,
  queriesPerRound: frames.length * project.rundown.length, mismatches, rounds };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
assert.equal(mismatches.length, 0, '索引复用改变了画面解析结果');
assert.equal(new Set(rounds.map(round => round.checksum)).size, 1);
console.log(JSON.stringify({ directory, ...report }, null, 2));
