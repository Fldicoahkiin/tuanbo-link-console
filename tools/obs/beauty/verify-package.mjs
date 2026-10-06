import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBeautyDistribution } from './distribution.mjs';

if (process.platform !== 'win32' || !process.argv[2]) throw new Error('用法：node tools/obs/beauty/verify-package.mjs <win-unpacked 目录>');
const source = dirname(fileURLToPath(import.meta.url));
const work = resolve(source, '../../../artifacts/beauty-prototype');
const directory = resolve(process.argv[2]);
const packaged = join(directory, 'resources/beauty');
const integrity = await verifyBeautyDistribution(source, work, packaged);
const { stdout } = await promisify(execFile)(join(packaged, 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe'), ['--help'], { windowsHide: true, timeout: 15000 });
for (const argument of ['--managed', '--body-model', '--body-on-demand', '--proposal-model', '--proposal-backend', '--semantic-model', '--semantic-backend', '--semantic-probability', '--instance-rtmdet-dir', '--profile-skin']) {
  if (!stdout.includes(argument)) throw new Error(`包内分析器未提供预期启动参数：${argument}`);
}
const result = { passed: true, directory, integrity, workerStartup: true,
  scope: 'Packaged file integrity and worker startup only; does not prove installed OBS loading, live processing or NSIS installation.' };
await writeFile(join(directory, '../beauty-package-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
