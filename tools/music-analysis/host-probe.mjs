import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// An explicit developer acceptance probe; never runs from the installed product.
const source = process.argv[2];
const output = process.argv[3];
const device = process.argv[4] ?? 'cpu';
if (!source || !output || !['cpu', 'cuda'].includes(device)) throw new Error('用法：node tools/music-analysis/host-probe.mjs <音源> <新的输出目录> [cpu|cuda]');
const directory = resolve(output);
await mkdir(directory, { recursive: false });
const workerDirectory = join(directory, 'worker');
await mkdir(workerDirectory);
for (const name of ['worker.py', 'analyze.py', 'phrase_structure.py', 'assets.py', 'contracts.py', 'consensus.py', 'evaluate.py', 'semantic_evaluation.py', 'pyproject.toml', 'uv.lock']) {
  await copyFile(resolve('tools/music-analysis', name), join(workerDirectory, name));
}
const bundle = join(directory, 'host.cjs');
await build({ entryPoints: ['apps/desktop/src/main/link/automatic-music-process.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', alias: { '@tb/schema': resolve('packages/schema/src/index.ts') } });
const { AutomaticMusicProcess } = await import(pathToFileURL(bundle).href);
const sourcePath = resolve(source);
const hash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
const progress = [];
const started = performance.now();
const worker = new AutomaticMusicProcess(resolve(`output/music-analysis/${device === 'cuda' ? 'env' : 'cpu-env'}/Scripts/python.exe`), join(workerDirectory, 'worker.py'), event => {
  progress.push({ ...event, hostElapsedSeconds: (performance.now() - started) / 1000 });
  process.stdout.write(`${event.stage}\n`);
}, 240_000);
const result = await worker.run({ version: 1, task_id: randomUUID(), audio: sourcePath, source_sha256: hash,
  bundle: resolve('output/music-analysis/models'), ffmpeg: resolve('node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg.exe'),
  output: join(directory, 'analysis'), cache: resolve('output/music-analysis/cache'), cancel_file: join(directory, 'cancel.signal'), device });
await writeFile(join(directory, 'host-report.json'), JSON.stringify({ version: 1, hostElapsedSeconds: (performance.now() - started) / 1000, progress, result }, null, 2), { flag: 'wx' });
process.stdout.write(`已完成：${result.timings.total_seconds.toFixed(3)} 秒，${result.publication}，缓存 ${String(result.timings.cached)}\n`);
