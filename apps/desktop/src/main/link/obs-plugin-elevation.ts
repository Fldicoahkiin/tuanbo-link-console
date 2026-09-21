import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const encoded = (value: string): string => Buffer.from(value, 'utf16le').toString('base64');

/** Fixed-purpose UAC operation. No destination or script comes from the renderer. */
export function obsPluginInstallScript(source: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('OBS 插件校验值无效');
  return `
$ErrorActionPreference='Stop'
$temporary=$null
try {
  $binary=[IO.File]::ReadAllBytes(${quote(resolve(source))})
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $actual=([BitConverter]::ToString($sha.ComputeHash($binary))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  if($actual -ne '${sha256}') { throw 'Plugin integrity check failed' }
  $root=[Environment]::GetFolderPath('CommonApplicationData')
  if(-not $root) { throw 'ProgramData unavailable' }
  $directory=Join-Path $root 'obs-studio\\plugins\\tblink-realtime-preview\\bin\\64bit'
  $target=Join-Path $directory 'tblink-realtime-preview.dll'
  $data=Join-Path $root 'obs-studio\\plugins\\tblink-realtime-preview\\data'
  foreach($leaf in @($target,$data)) {
    $candidate=$leaf
    while($candidate) {
      if(Test-Path -LiteralPath $candidate) {
        if(([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Plugin directory contains a reparse point' }
      }
      $candidate=[IO.Path]::GetDirectoryName($candidate)
    }
  }
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  [IO.Directory]::CreateDirectory($data) | Out-Null
  $temporary=Join-Path $directory ('.'+[Guid]::NewGuid().ToString()+'.tmp')
  $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  try { $stream.Write($binary,0,$binary.Length) } finally { $stream.Dispose() }
  if([IO.File]::Exists($target)) { [IO.File]::Replace($temporary,$target,$null) }
  else { [IO.File]::Move($temporary,$target) }
} catch { exit 1 }
finally { if($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
exit 0
`;
}

export async function elevateObsPluginInstall(source: string, sha256: string): Promise<void> {
  const script = obsPluginInstallScript(source, sha256);
  const launcher = `$ErrorActionPreference='Stop'; try { $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded(script)}') -Wait -PassThru; if($p.ExitCode -ne 0){throw '插件部署失败：文件可能仍被 OBS 占用，或目标目录不可写。原插件不会被截断。'} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  try {
    await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(launcher)], { windowsHide: true });
  } catch (error) {
    throw new Error('OBS 组件部署未完成。Windows 授权被取消，或组件仍被占用；请处理后在软件中再次点击“检查并修复组件”。', { cause: error });
  }
}
