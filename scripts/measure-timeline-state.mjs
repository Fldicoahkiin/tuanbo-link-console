import { build } from 'esbuild';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [fixture, baseline] = process.argv.slice(2);
if (!fixture || !baseline) throw new Error('用法：node scripts/measure-timeline-state.mjs <tblink> <旧版解析模块>');
const directory = await mkdtemp(resolve('artifacts/timeline-state-measurement-'));
const modulePath = join(directory, 'current.mjs');
await build({ entryPoints: ['packages/core/src/timeline-state.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'esm' });
const { TimelineStateIndex } = await import(pathToFileURL(modulePath).href);
const { resolveTimelineState } = await import(pathToFileURL(resolve(baseline)).href);
const project = JSON.parse(await readFile(resolve(fixture), 'utf8'));
const positions = [0, 999, 1000, 11999, 12000, 12001, 23999, 24000, 107999, 108000];
for (const item of project.rundown) {
  const index = new TimelineStateIndex(project, item);
  for (const position of positions) assert.deepEqual(index.at(position), resolveTimelineState(project, item, position));
}
const rounds = [];
for (let round = 0; round < 3; round++) for (const cached of round % 2 ? [true, false] : [false, true]) {
  const started = performance.now(); let checksum = 0;
  for (const item of project.rundown) {
    const index = cached ? new TimelineStateIndex(project, item) : null;
    for (let position = 0; position < 108000; position += 900) {
      const output = index ? index.at(position) : resolveTimelineState(project, item, position);
      checksum += output.activeClipIds.length + output.activeObsCueIds.length;
    }
  }
  rounds.push({ round, cached, elapsedMs: performance.now() - started, checksum });
}
assert.equal(new Set(rounds.map(round => round.checksum)).size, 1);
const report = { scope: '时间线状态函数对比，不代表界面或长时输出验收', fixture: resolve(fixture), baseline: resolve(baseline), semanticQueries: project.rundown.length * positions.length, queriesPerRound: project.rundown.length * 120, rounds };
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ directory, ...report }, null, 2));
