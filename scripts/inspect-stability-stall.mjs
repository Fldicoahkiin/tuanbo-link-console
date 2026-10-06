import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2]);
const trace = JSON.parse(await readFile(join(directory, 'renderer-trace.json'), 'utf8'));
const cpu = JSON.parse(await readFile(join(directory, 'renderer-cpu.json'), 'utf8')).profile;
const events = trace.traceEvents;
const nodes = new Map(cpu.nodes.map(node => [node.id, node]));
const parents = new Map(cpu.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])));
const markers = events.filter(event => event.name === 'stability-ui-gap');
const reports = markers.map(marker => {
  const detail = JSON.parse(marker.args.data.detail);
  if (!Number.isFinite(detail.elapsedMs) || detail.elapsedMs <= 0) throw new Error('界面停顿标记缺少有效时长');
  const windowMs = Math.max(120, detail.elapsedMs + 5);
  const end = marker.ts, start = end - windowMs * 1000, weights = new Map(), stacks = new Map();
  let now = cpu.startTime;
  for (let index = 0; index < cpu.samples.length; index++) {
    const delta = cpu.timeDeltas[index], before = now; now += delta;
    if (now < start || before > end) continue;
    const time = Math.max(0, Math.min(now, end) - Math.max(before, start));
    const id = cpu.samples[index]; weights.set(id, (weights.get(id) ?? 0) + time);
    let current = id; const stack = [];
    while (current) { const node = nodes.get(current); stack.unshift(node.callFrame.functionName || `anonymous:${node.callFrame.lineNumber}`); current = parents.get(current); }
    const key = stack.join(' > '); stacks.set(key, (stacks.get(key) ?? 0) + time);
  }
  return { marker, windowMs, tasks: events.filter(event => event.ph === 'X' && event.ts < end && event.ts + (event.dur ?? 0) > start && event.dur >= 1000)
    .map(event => ({ name: event.name, atMs: (event.ts - end) / 1000, durationMs: event.dur / 1000, pid: event.pid, tid: event.tid, args: event.args }))
    .sort((a, b) => b.durationMs - a.durationMs).slice(0, 40),
  cpu: [...weights].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, microseconds]) => ({ ms: microseconds / 1000, frame: nodes.get(id).callFrame })),
  stacks: [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([stack, us]) => ({ ms: us / 1000, stack })) };
});
await writeFile(join(directory, 'stall-analysis.json'), JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
