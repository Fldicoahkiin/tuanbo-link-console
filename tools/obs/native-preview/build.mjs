import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'win32') throw new Error('OBS 原生预览插件必须在 Windows 构建');
const compiler = join(root, 'compiler', 'zig-x86_64-windows-0.14.1', 'zig.exe');
const run = (exe, args, env = process.env) => { const result = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true, env }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`${exe} 构建失败：${result.status}`); };
try { await access(compiler); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const release = JSON.parse(await readFile(join(root, 'compiler-release.json'), 'utf8'));
  const response = await fetch(release.tarball);
  if (!response.ok) throw new Error(`下载编译器失败：${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== release.shasum) throw new Error('编译器 SHA-256 不匹配');
  await mkdir(join(root, 'compiler'), { recursive: true });
  const zip = join(root, 'zig.zip'); await writeFile(zip, bytes);
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  // Started from PowerShell 7, the inherited module path makes Windows PowerShell fail to autoload Expand-Archive.
  const windowsPowerShellEnv = { ...process.env }; delete windowsPowerShellEnv.PSModulePath;
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(join(root, 'compiler'))} -Force`], windowsPowerShellEnv);
}
run(compiler, ['cc', '-target', 'x86_64-windows-gnu', '-shared', '-O2', '-Wall', '-Wextra', join(root, 'preview.c'), '-ladvapi32', '-o', join(root, 'tblink-realtime-preview.dll')]);
