import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Real WASAPI, silent PCM, no MIDI or OBS. This measures the service boundary,
// not physical acoustic continuity or renderer/OBS preparation overhead.
assert.equal(process.platform, 'win32');
const executable = resolve(process.argv[2] || 'tools/playback-engine/bin/tblink-playback.exe');
const engineSha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
const directory = await mkdtemp(resolve('artifacts/native-boundary-'));
const bundle = join(directory, 'service.cjs');
await build({ stdin: { contents: "export { NativePlayerService } from './apps/desktop/src/main/link/native-player-service'; export { NativeAudioCache } from './apps/desktop/src/main/link/native-audio-cache';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle,
  alias: { '@tb/schema': resolve('packages/schema/src/index.ts'), '@tb/core/link': resolve('packages/core/src/link-public.ts') } });
const require = createRequire(resolve('apps/desktop/package.json'));
const { NativePlayerService, NativeAudioCache } = require(bundle);
const wav = Buffer.alloc(44 + 48000 * 4 * 3);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(48000 * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const audio = join(directory, 'silence.wav'); await writeFile(audio, wav);
const snapshots = Array.from({ length: 8 }, (_, index) => ({ version: 1, projectId: 'boundary', itemId: `song-${index}`, revision: 1,
  audio: { relativePath: 'silence.wav', sha256: createHash('sha256').update(wav).digest('hex'), durationMs: 3000 },
  startMs: 100, positionMs: 100, endMs: 1000, offsetMs: 480000 + index * 60000, sampleRate: 48000, frameRate: 30, volume: 0 }));
const measurements = [], transitions = [], failures = [], states = [];
let phaseItem = null;
const player = new NativePlayerService({ executable, cache: new NativeAudioCache(join(directory, 'cache'), require('ffmpeg-static')),
  resolveAudio: () => audio, error: message => failures.push(message),
  measured: (phase, durationMs) => measurements.push({ itemId: phaseItem, phase, durationMs }),
  changed: state => {
    const prior = states.at(-1);
    if (prior?.status !== state.status || prior?.itemId !== state.itemId) states.push({ atMs: performance.now(), itemId: state.itemId, status: state.status, positionMs: state.positionMs });
    if (state.underruns || state.audioError) failures.push({ underruns: state.underruns, audioError: state.audioError });
  } });
let generation = 0;
const sessionId = randomUUID();
try {
  for (const [index, snapshot] of snapshots.entries()) {
    phaseItem = snapshot.itemId;
    const started = performance.now(), previous = states.findLast(state => state.status === 'ended');
    await player.prepare({ version: 1, sessionId, generation: ++generation, projectPath: join(directory, 'boundary.tblink'),
      snapshot, ...(snapshots[index + 1] ? { nextSnapshot: snapshots[index + 1] } : {}), audioDeviceId: 'default', midiPortName: null });
    await player.control({ version: 1, sessionId, generation: ++generation, kind: 'play' });
    const playing = states.findLast(state => state.itemId === snapshot.itemId && state.status === 'playing');
    assert(playing, 'No playing device-clock observation');
    transitions.push({ itemId: snapshot.itemId, prepareAndPlayMs: performance.now() - started,
      gapFromEndedObservationMs: previous ? playing.atMs - previous.atMs : null });
    const deadline = performance.now() + 5000;
    while (player.status?.status !== 'ended' && performance.now() < deadline) {
      assert.notEqual(player.status?.status, 'error'); await delay(5);
    }
    assert.equal(player.status?.status, 'ended');
  }
} catch (error) { failures.push(String(error)); process.exitCode = 1; }
finally {
  try { await player.close(); } catch (error) { failures.push(String(error)); process.exitCode = 1; }
  await writeFile(join(directory, 'measurement.json'), JSON.stringify({ scope: '静音WASAPI服务层换歌观测；不代表无缝输出、正式UI/OBS或长时验收',
    acceptance: false, executable, engineSha256, transitions, measurements, states, failures }, null, 2));
  console.log(JSON.stringify({ directory, failures, transitions }, null, 2));
}
