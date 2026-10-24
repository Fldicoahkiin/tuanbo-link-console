// Summarises one long-run out dir (written by longrun.mjs): memory and handle trends per process,
// playback counters, timecode continuity and drift, OBS switch timing spread and logs. Prints JSON.
// usage: node tools/longrun/summary.mjs <outDir>/run
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: node tools/longrun/summary.mjs <run dir>');
// A run ended by its time limit can leave a half-written last line; such lines are counted, not read.
const unparsed = {};
const lines = name => {
  const path = join(root, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split('\n').map(line => line.trim()).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { unparsed[name] = (unparsed[name] ?? 0) + 1; return []; }
  });
};
const count = values => values.reduce((counts, value) => { counts[value] = (counts[value] ?? 0) + 1; return counts; }, {});
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
// Least-squares slope of (time ms, value) per hour.
function perHour(points) {
  if (points.length < 3) return null;
  const xs = points.map(([t]) => t / 3600000), ys = points.map(([, v]) => v), mx = mean(xs), my = mean(ys);
  const den = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return den === 0 ? null : xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0) / den;
}
function trend(points, scale = 1) {
  if (!points.length) return null;
  const scaled = points.map(([t, v]) => [t, v * scale]), values = scaled.map(([, v]) => v), slope = perHour(scaled);
  return { first: round(values[0]), last: round(values.at(-1)), max: round(Math.max(...values)), perHour: slope === null ? null : round(slope, 2), samples: values.length };
}

const summary = {};
const samples = lines('samples.jsonl');
summary.samples = samples.length;
if (samples.length) {
  summary.wallMinutes = round((samples.at(-1).t - samples[0].t) / 60000);
  summary.phases = count(samples.map(sample => sample.phase));
  const electron = {};
  for (const sample of samples) if (Array.isArray(sample.metrics)) for (const metric of sample.metrics) (electron[`${metric.type}:${metric.pid}`] ??= []).push([sample.t, metric.priv ?? 0]);
  summary.electronPrivateMB = Object.fromEntries(Object.entries(electron).filter(([, points]) => points.length >= 2).map(([key, points]) => [key, trend(points, 1 / 1024)]));
  const external = {};
  for (const sample of samples) if (Array.isArray(sample.external)) for (const process of sample.external) {
    const entry = external[`${process.name}:${process.pid}`] ??= { priv: [], handles: [], threads: [], cpu: [] };
    entry.priv.push([sample.t, process.priv]); entry.handles.push([sample.t, process.handles]);
    entry.threads.push([sample.t, process.threads]); entry.cpu.push([sample.t, process.cpuSeconds]);
  }
  // Long-lived processes get trends; per-song helpers seen in few samples are only counted.
  const longLived = Math.max(3, Math.floor(samples.length / 2));
  summary.processes = Object.fromEntries(Object.entries(external).filter(([, entry]) => entry.priv.length >= longLived).map(([key, entry]) => [key, {
    privateMB: trend(entry.priv, 1 / 1048576), handles: trend(entry.handles), threads: trend(entry.threads),
    cpuSecondsUsed: round(entry.cpu.at(-1)[1] - entry.cpu[0][1]) }]));
  summary.shortLivedProcesses = count(Object.entries(external).filter(([, entry]) => entry.priv.length < longLived).map(([key]) => key.split(':')[0]));
  summary.logStoreSize = [samples[0].logStoreSize, samples.at(-1).logStoreSize];
  summary.infoLogs = samples.at(-1).infoLogs;
}

const plays = lines('plays.jsonl');
summary.plays = { total: plays.length, byItem: count(plays.map(play => play.itemId)),
  underruns: plays.reduce((sum, play) => sum + (play.underruns ?? 0), 0), mtcInterruptions: plays.reduce((sum, play) => sum + (play.mtcInterruptions ?? 0), 0),
  withMtcError: plays.filter(play => play.mtcErrors?.length).map(play => ({ index: play.index, itemId: play.itemId, errors: play.mtcErrors })),
  audioErrors: plays.filter(play => play.audioError).map(play => ({ index: play.index, itemId: play.itemId, error: play.audioError })),
  endStatus: count(plays.map(play => play.endStatus)), mtcSentZero: plays.filter(play => !play.mtcSent).length };

const events = lines('events.jsonl');
summary.events = { kinds: count(events.map(event => event.kind)),
  unexpected: events.filter(event => ['unexpected-stop', 'failure', 'pageerror', 'poll-failed'].includes(event.kind)).slice(0, 20),
  obsConnect: events.filter(event => event.kind === 'obs-connect').map(event => event.result), notes: events.filter(event => event.kind === 'note').map(event => event.message) };

const driftRows = lines('drift.jsonl'), drift = driftRows.filter(row => row.driftMs !== null && row.driftMs !== undefined).map(row => row.driftMs);
if (drift.length) {
  const absolute = drift.map(Math.abs).sort((a, b) => a - b);
  summary.driftMs = { samples: drift.length, min: Math.min(...drift), max: Math.max(...drift), mean: round(mean(drift)),
    p95Abs: absolute.length >= 20 ? absolute[Math.floor(absolute.length * 0.95) - 1] : absolute.at(-1), withoutTimecode: driftRows.length - drift.length };
} else summary.driftMs = { samples: 0, withoutTimecode: driftRows.length };

// A gap, break in order or stop just before or at a song start, a rundown end or a segment boundary is a transition.
const boundaries = [...plays.map(play => Date.parse(play.startedAt)), ...events.filter(event => ['rundown-end', 'unexpected-stop', 'note'].includes(event.kind)).map(event => Date.parse(event.at))];
const nearBoundary = at => boundaries.some(boundary => (at - boundary >= -3000 && at - boundary <= 1500) || (boundary - at >= -1500 && boundary - at <= 4000));
const counts = {}, inSong = [];
for (const event of lines('mtc.jsonl.events.jsonl')) {
  const where = nearBoundary(event.at) ? 'transition' : 'inSong';
  (counts[event.kind] ??= { transition: 0, inSong: 0 })[where]++;
  if (where === 'inSong') inSong.push(event);
}
summary.mtcEvents = { counts, inSong: inSong.slice(0, 30) };
const windows = lines('mtc.jsonl').filter(row => 'qf' in row);
if (windows.length) summary.mtc = { final: windows.at(-1).total, windows: windows.length, windowsWithJumps: windows.filter(row => row.jumps).length,
  windowsWithOutOfOrder: windows.filter(row => row.outOfOrder).length, windowsWithGap100: windows.filter(row => row.gaps100).length };

// Program scene changes per play, aligned by order; the spread of each change's song position across plays.
const byPlay = {};
for (const change of lines('obs.jsonl').filter(row => row.phase === 'playing' && row.pos !== null && row.pos !== undefined)) (byPlay[`${change.itemId}\u0000${change.play}`] ??= []).push([change.pos, change.scene]);
const perItem = {};
for (const [key, changes] of Object.entries(byPlay)) (perItem[key.split('\u0000')[0]] ??= []).push(changes);
summary.obsSwitches = Object.fromEntries(Object.entries(perItem).map(([item, runs]) => {
  const lengths = count(runs.map(run => run.length)), usual = Number(Object.entries(lengths).sort((a, b) => b[1] - a[1])[0][0]);
  const aligned = runs.filter(run => run.length === usual);
  const changes = Array.from({ length: usual }, (_, index) => {
    const positions = aligned.map(run => run[index][0]).sort((a, b) => a - b), median = positions[Math.floor(positions.length / 2)];
    return { scene: aligned[0][index][1], medianPos: Math.round(median), maxDeviationMs: Math.round(Math.max(...positions.map(position => Math.abs(position - median)))) };
  });
  return [item, { plays: runs.length, changeCounts: lengths, events: changes }];
}));

const logs = lines('logs.jsonl');
summary.logs = { byLevel: count(logs.map(log => log.level)),
  top: Object.entries(count(logs.map(log => `${log.level} | ${log.device ?? ''} | ${String(log.message).slice(0, 140)}`))).sort((a, b) => b[1] - a[1]).slice(0, 12) };
summary.unparsedLines = unparsed;
if (existsSync(join(root, 'result.json'))) summary.result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8').replace(/^\uFEFF/, ''));
console.log(JSON.stringify(summary, null, 1));
