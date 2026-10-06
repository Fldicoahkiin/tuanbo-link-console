import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint, recordBuild } from './distribution.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const startedInputs = await sourceFingerprint(source, 'runtime');
const work = resolve(source, '../../../artifacts/beauty-prototype');
if (process.platform !== 'win32') throw new Error('美颜运行时必须在 Windows 原生环境构建');
const python = join(work, 'python/Scripts/python.exe');
await access(python);
function run(args) {
  const result = spawnSync(python, args, { windowsHide: true, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`美颜运行时构建失败 (${result.status})`);
}
run(['-c', 'import PyInstaller; assert PyInstaller.__version__ == "6.16.0", "Install requirements-build.txt first"']);
run(['-c', 'import onnxruntime as ort; assert ort.__version__ == "1.24.4" and "DmlExecutionProvider" in ort.get_available_providers(), "Pinned DirectML runtime is required"']);
run(['-c', 'import openvino; assert openvino.__version__.split("-")[0] == "2024.6.0", "Pinned OpenVINO runtime is required"']);
run(['-m', 'PyInstaller', '--noconfirm', '--onedir', '--name', 'tblink-beauty-worker',
  '--distpath', join(work, 'runtime'), '--workpath', join(work, 'freeze-work'), '--specpath', work,
  '--collect-data', 'mediapipe', '--collect-binaries', 'onnxruntime', '--collect-data', 'onnxruntime',
  '--collect-binaries', 'openvino', '--collect-data', 'openvino', '--copy-metadata', 'openvino', '--copy-metadata', 'openvino-telemetry',
  '--add-data', `${join(source, 'instance-assets.json')};.`,
  '--add-data', `${join(source, 'derived-models.json')};.`,
  '--copy-metadata', 'onnxruntime-directml', '--add-data', `${join(source, 'assets.json')};.`, join(source, 'worker.py')]);
const executable = join(work, 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe');
const result = spawnSync(executable, ['--help'], { windowsHide: true, stdio: 'inherit' });
if (result.error || result.status !== 0) throw new Error('独立运行时启动失败', { cause: result.error });
await writeFile(join(work, 'runtime/build.json'), JSON.stringify({
  pyinstaller: '6.16.0', sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
  validation: '启动检查通过；图像效果必须另行运行 verify.mjs --live --frozen'
}, null, 2));
await recordBuild(source, work, 'runtime', startedInputs);
