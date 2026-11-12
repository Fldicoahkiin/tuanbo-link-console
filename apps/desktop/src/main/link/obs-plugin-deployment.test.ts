import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installObsLiveBridge } from './obs-live-install';
import { obsPluginInstallScript } from './obs-plugin-elevation';

afterEach(() => { vi.unstubAllEnvs(); });

// The deployment only runs on Windows, and the elevation script is parsed by the system PowerShell.
const onWindows = it.skipIf(process.platform !== 'win32');

onWindows('全新隔离目录：首次部署、重复安装和损坏修复', async () => {
  const artifacts = resolve('artifacts');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'obs-deployment-'));
  vi.stubEnv('ProgramData', directory);
  const source = process.env.TBLINK_OBS_PACKAGED_DLL ?? join(directory, 'bundled.dll');
  if (!process.env.TBLINK_OBS_PACKAGED_DLL) {
    const fixture = Buffer.alloc(384);
    fixture.writeUInt16LE(0x5a4d); fixture.writeUInt32LE(64, 60); fixture.writeUInt32LE(0x4550, 64);
    fixture.writeUInt16LE(0x8664, 68); fixture.writeUInt16LE(240, 84); fixture.writeUInt16LE(0x20b, 88);
    await writeFile(source, fixture);
  }
  const target = join(directory, 'obs-studio/plugins/tblink-realtime-preview/bin/64bit/tblink-realtime-preview.dll');
  await installObsLiveBridge(source);
  expect(await readFile(target)).toEqual(await readFile(source));
  await installObsLiveBridge(source);
  await writeFile(target, 'damaged');
  await installObsLiveBridge(source);
  expect(await readFile(target)).toEqual(await readFile(source));
  expect(await readdir(join(directory, 'obs-studio/plugins/tblink-realtime-preview/bin/64bit'))).toEqual(['tblink-realtime-preview.dll']);
});

onWindows('Windows 授权脚本按 PowerShell 语法解析，路径含引号和特殊字符不会注入命令', async () => {
  const script = obsPluginInstallScript("C:/应用's/$data/组件.dll", 'a'.repeat(64));
  expect(script).toContain("应用''s\\$data");
  expect(script).toContain('ReparsePoint');
  expect(script).toContain('File]::Replace');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const parse = `$s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput($s,[ref]$tokens,[ref]$errors)|Out-Null; if($errors.Count){$errors|Out-String|Write-Error;exit 1}`;
  await expect(promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parse, 'utf16le').toString('base64')], { windowsHide: true })).resolves.toMatchObject({ stderr: '' });
  expect(() => obsPluginInstallScript('C:/test.dll', 'bad')).toThrow('校验值无效');
});
