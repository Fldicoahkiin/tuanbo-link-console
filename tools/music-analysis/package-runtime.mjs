// Assemble the isolated Windows CPU runtime that the official package ships (pinned in release-pin.json).
// Preparation is offline: all packages and weights must already exist locally.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { musicWorkerFiles } from './release-pin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'win32' || !process.argv[2]) throw new Error('需要 Windows 和新的模型包输出目录');
const destination = resolve(process.argv[2]);
const environment = join(root, 'output/music-analysis/cpu-env');
const python = join(environment, 'Scripts/python.exe');
function query(executable, code) {
  const result = spawnSync(executable, ['-I', '-B', '-c', code], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || '音乐运行时检查失败');
  return JSON.parse(result.stdout);
}
const base = query(python, 'import json,sys,torch,torchaudio; print(json.dumps(dict(base=sys.base_prefix,version=list(sys.version_info[:3]),torch=torch.__version__,torchaudio=torchaudio.__version__)))');
if (base.version.join('.') !== '3.11.9' || base.torch !== '2.7.1+cpu' || base.torchaudio !== '2.7.1+cpu') throw new Error('运行时版本不符，未切换依赖');
await mkdir(destination); // Never overwrite a prior bundle.
const runtime = join(destination, 'runtime');
await mkdir(runtime);
const skip = new Set(['__pycache__', '_virtualenv.py', '_virtualenv.pth']);
const filter = path => !skip.has(basename(path)) && !/\.(pyc|pyo|whl)$/.test(path);
for (const name of ['python.exe', 'python3.dll', 'python311.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'LICENSE.txt']) {
  await cp(join(base.base, name), join(runtime, name));
}
await cp(join(base.base, 'DLLs'), join(runtime, 'DLLs'), { recursive: true, filter });
await cp(join(base.base, 'Lib'), join(runtime, 'Lib'), { recursive: true, filter: path => basename(path) !== 'site-packages' && filter(path) });
await cp(join(environment, 'Lib/site-packages'), join(runtime, 'Lib/site-packages'), { recursive: true, filter });
// _pth ignores machine Python, registry entries, PYTHONPATH and user site packages.
// The parent contains our worker modules; site processes package DLL loader hooks.
await writeFile(join(runtime, 'python311._pth'), '.\nLib\nDLLs\nLib/site-packages\n..\nimport site\n');
for (const name of musicWorkerFiles) await cp(join(root, 'tools/music-analysis', name), join(destination, name));
await cp(join(root, 'output/music-analysis/models'), join(destination, 'models'), { recursive: true });
const notices = join(destination, 'licenses');
await mkdir(notices);
for (const name of ['all-in-one-infer-8414233b743d6ccec46e36ab4cfeddb4605ff3bf', 'demucs-infer-ffe0080ef96336a34e3f0ee8ba22ceaa0623a36c', 'madmom-infer-a9ed04ec942dd6ec5309df7ce7f3783d1bb42575']) {
  const source = join(root, 'output/music-analysis/downloads', name);
  for (const file of await readdir(source)) if (/^(LICENSE|NOTICE)/i.test(file)) await cp(join(source, file), join(notices, `${name}-${file}`));
}
const verification = query(join(runtime, 'python.exe'), 'import json,sys,torch,torchaudio,beat_this,allin1_infer,demucs_infer,madmom_infer,librosa,soundfile,pydantic; from pathlib import Path; from assets import verify_assets; print(json.dumps(dict(prefix=sys.prefix,paths=sys.path,torch=torch.__version__,modelDigest=verify_assets(Path(sys.prefix).parent / "models",Path(sys.prefix).parent / "models/manifest.json"))))');
if (verification.paths.some(path => resolve(path).toLowerCase() !== destination.toLowerCase() && !resolve(path).toLowerCase().startsWith(destination.toLowerCase() + '\\'))) throw new Error('运行时仍依赖安装目录外的 Python 路径');
const files = [];
async function inventory(directory, relative = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await inventory(path, name);
    else {
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
      files.push({ path: name, bytes, sha256: hash.digest('hex') });
    }
  }
}
await inventory(destination);
await writeFile(join(destination, 'runtime-manifest.json'), JSON.stringify({ version: 1, channel: 'release', device: 'cpu', python: base.version.join('.'), torch: verification.torch, modelDigest: verification.modelDigest, files }, null, 2));
console.log(`离线音乐运行时准备完成：${files.length} 文件，${files.reduce((sum, file) => sum + file.bytes, 0)} 字节`);
