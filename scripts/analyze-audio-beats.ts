import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { analyzeIbtAudio } from '../apps/desktop/src/main/link/ibt-beat-service';

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
  const beats = await analyzeIbtAudio(resolve(dirname(projectPath), audio.relativePath), audio.durationMs, (input, output) => new Promise<void>((done, fail) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-threads', '1', '-i', input, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', '-y', output], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-8000); });
    child.stderr.on('error', fail);
    child.on('error', fail); child.on('close', (code) => code === 0 ? done() : fail(new Error(error)));
  }), resolve('tools/ibt/bin/ibt.exe'));
  results.push({ title: item.title, durationMs: audio.durationMs, counts: { sparse: beats.sparse.length, standard: beats.standard.length, dense: beats.dense.length }, beats });
}
await mkdir('artifacts/beat-research', { recursive: true });
await writeFile('artifacts/beat-research/analysis.json', JSON.stringify(results, null, 2));
console.log(results.map(({ title, counts }) => ({ title, counts })));
