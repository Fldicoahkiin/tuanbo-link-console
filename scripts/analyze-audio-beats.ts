import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AudioBeatDetector } from '../packages/core/src/audio-beat-detection';

const requireDesktop = createRequire(resolve('apps/desktop/package.json'));
const ffmpeg: unknown = requireDesktop('ffmpeg-static');
if (typeof ffmpeg !== 'string') throw new Error('FFmpeg 未安装');
const projectPath = process.argv[2];
if (!projectPath) throw new Error('请提供工程路径');
const data: unknown = JSON.parse(await readFile(projectPath, 'utf8'));
const { parseLinkProject } = await import('../packages/schema/src/index');
const project = parseLinkProject(data);
const results = [];
for (const item of project.rundown) {
  const audio = item.referenceAudio; if (!audio) continue;
  const detector = new AudioBeatDetector(); let remainder = Buffer.alloc(0);
  await new Promise<void>((done, fail) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', resolve(dirname(projectPath), audio.relativePath), '-ac', '1', '-ar', '22050', '-f', 'f32le', 'pipe:1'], { windowsHide: true });
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const bytes = Buffer.concat([remainder, chunk]); const size = bytes.length - bytes.length % 4;
      for (let offset = 0; offset < size; offset += 4) detector.push(bytes.readFloatLE(offset));
      remainder = Buffer.from(bytes.subarray(size));
    });
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
    child.on('error', fail); child.on('close', (code) => code === 0 ? done() : fail(new Error(error)));
  });
  const beats = detector.finish(audio.durationMs);
  results.push({ title: item.title, durationMs: audio.durationMs, counts: { sparse: beats.sparse.length, standard: beats.standard.length, dense: beats.dense.length }, beats });
}
await writeFile('artifacts/beat-research/analysis.json', JSON.stringify(results, null, 2));
console.log(results.map(({ title, counts }) => ({ title, counts })));
