import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = resolve(process.argv[2] ?? `artifacts/seek-pixels-${Date.now()}`);
await mkdir(directory, { recursive: true });
const require = createRequire(resolve('apps/desktop/package.json')), ffmpeg = require('ffmpeg-static');
const bundle = join(directory, 'cache-service.cjs');
await build({ stdin: { contents: "export { MediaPreviewService } from './apps/desktop/src/main/link/media-preview-service'; export { LinkProjectService } from './apps/desktop/src/main/link/link-project-service';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', loader: { '.lua': 'text' }, alias: { '@tb/schema': resolve('packages/schema/src/index.ts'), '@tb/core/link': resolve('packages/core/src/link-public.ts') }, outfile: bundle });
const { MediaPreviewService, LinkProjectService } = require(bundle);
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data.toString('utf8'); });
    child.stderr.on('data', data => { errors = (errors + data.toString('utf8')).slice(-8192); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`FFmpeg ${code}: ${errors}`)));
  });
}
const service = new MediaPreviewService(new LinkProjectService(), undefined, () => ffmpeg);
const rows = [];
for (const format of ['yuv420p', 'yuv420p10le', 'bgra']) {
  const source = join(directory, `${format}.mkv`);
  const filters = format === 'bgra' ? 'testsrc=size=128x96:rate=10:duration=1,format=rgba,colorchannelmixer=aa=0.25,format=bgra'
    : `testsrc2=size=128x96:rate=10:duration=1,format=${format}`;
  await run(['-n', '-f', 'lavfi', '-i', filters, '-c:v', 'ffv1', '-level', '3', '-g', '1', '-threads', '2', source]);
  const sha256 = createHash('sha256').update(await readFile(source)).digest('hex');
  const cache = await service.ensureObsSeekVideo(join(directory, 'acceptance.tblink'), `${format}.mkv`, sha256);
  const decoded = file => run(['-i', file, '-map', '0:v:0', '-pix_fmt', format, '-f', 'framemd5', '-']);
  const original = await decoded(source), cached = await decoded(cache);
  assert.deepEqual(cached.split('\n').filter(line => line && !line.startsWith('#')), original.split('\n').filter(line => line && !line.startsWith('#')));
  if (format === 'bgra') {
    const alpha = await run(['-i', cache, '-vf', 'alphaextract', '-f', 'framemd5', '-']);
    assert(alpha.includes(',  '), 'alpha plane must decode');
    await writeFile(join(directory, 'alpha.framemd5'), alpha);
  }
  await writeFile(join(directory, `${format}.framemd5`), cached);
  rows.push({ format, frames: cached.split('\n').filter(line => line && !line.startsWith('#')).length, cache, decodedFramesIdentical: true });
}
await writeFile(join(directory, 'report.json'), JSON.stringify({ passed: true, scope: 'real FFmpeg cache pixel/depth/alpha roundtrip; not OBS timing acceptance', rows }, null, 2));
console.log(JSON.stringify({ directory, rows }, null, 2));
