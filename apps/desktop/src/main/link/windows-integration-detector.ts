import { spawn } from 'node:child_process';
import type { LinkDetectedApplication, LinkLocalIntegrationDetection, LinkProcessSnapshot } from '@tb/core/link';

type PowerShellRunner = (script: string, timeoutMs: number) => Promise<string>;

const MANAGED_APPLICATION_IDS = ['obs', 'p1'] as const;

export class WindowsIntegrationDetector {
  constructor(private readonly runPowerShell: PowerShellRunner = executePowerShell) {}

  async detect(): Promise<LinkLocalIntegrationDetection> {
    const output = await this.runPowerShell(DISCOVERY_SCRIPT, 15_000);
    let value: unknown;
    try {
      value = parseJson(output);
    } catch (error) {
      throw new Error('Windows 本机集成检测返回了无效 JSON', { cause: error });
    }
    return parseDetection(value);
  }
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseDetection(value: unknown): LinkLocalIntegrationDetection {
  if (!isRecord(value) || typeof value.detectedAt !== 'string' || !Array.isArray(value.applications)) {
    throw new Error('Windows 本机集成检测返回结构无效');
  }
  const applications = {} as Record<LinkProcessSnapshot['id'], LinkDetectedApplication>;
  const detectedApplications = value.applications as unknown[];
  for (const id of MANAGED_APPLICATION_IDS) {
    const candidate: unknown = detectedApplications.find((item) => isRecord(item) && item.id === id);
    if (!isDetectedApplication(candidate, id)) throw new Error(`Windows 本机集成检测缺少有效目标：${id}`);
    applications[id] = candidate;
  }
  return { detectedAt: value.detectedAt, applications };
}

function isDetectedApplication(value: unknown, id: LinkProcessSnapshot['id']): value is LinkDetectedApplication {
  return isRecord(value)
    && value.id === id
    && isNullableString(value.executablePath)
    && isNullableString(value.workingDirectory)
    && isNullableString(value.processName)
    && isNullableString(value.windowTitle)
    && isNullableString(value.version)
    && typeof value.running === 'boolean';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function executePowerShell(script: string, timeoutMs: number): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Windows 本机集成检测超过 ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`Windows 本机集成检测失败（${String(code)}）：${errorOutput}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

const DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$entries = @(Get-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue)

function Find-Entry([string]$pattern) {
  return @($entries | Where-Object { $_.DisplayName -match $pattern } | Sort-Object DisplayVersion -Descending | Select-Object -First 1)[0]
}
function Find-Process([string]$name) {
  $items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq $name } | ForEach-Object {
    $process = Get-Process -Id $_.ProcessId -ErrorAction Stop
    [PSCustomObject]@{ path=$_.ExecutablePath; name=$_.Name; title=$process.MainWindowTitle }
  })
  $withWindow = @($items | Where-Object { $_.title })
  if ($withWindow.Count -gt 0) { return $withWindow[0] }
  if ($items.Count -gt 0) { return $items[0] }
  return $null
}
function Icon-Path($entry) {
  if (-not $entry -or -not $entry.DisplayIcon) { return $null }
  return ([string]$entry.DisplayIcon).Trim('"') -replace ',\d+$',''
}
function Version-For([string]$path, $entry) {
  if ($path -and (Test-Path -LiteralPath $path)) {
    $info = (Get-Item -LiteralPath $path).VersionInfo
    if ($info.FileVersion) { return [string]$info.FileVersion }
    if ($info.ProductVersion) { return [string]$info.ProductVersion }
  }
  if ($entry -and $entry.DisplayVersion) { return [string]$entry.DisplayVersion }
  return $null
}
function App([string]$id, [string]$path, $process, $entry) {
  if ($path) { $path = [IO.Path]::GetFullPath($path) }
  [PSCustomObject]@{
    id = $id
    executablePath = $path
    workingDirectory = $(if ($path) { [IO.Path]::GetDirectoryName($path) } else { $null })
    processName = $(if ($process) { [string]$process.name } elseif ($path) { [IO.Path]::GetFileName($path) } else { $null })
    windowTitle = $(if ($process) { [string]$process.title } else { $null })
    version = Version-For $path $entry
    running = [bool]$process
  }
}

$obsEntry = Find-Entry '^OBS Studio'
$obsProcess = Find-Process 'obs64.exe'
$obsPath = if ($obsProcess) { $obsProcess.path } else { Icon-Path $obsEntry }

$p1Entry = Find-Entry '^Hirender P1'
$p1Process = Find-Process 'HirenderP1.exe'
$p1Path = if ($p1Process) { $p1Process.path } elseif ($p1Entry -and $p1Entry.InstallLocation) { Join-Path $p1Entry.InstallLocation 'HirenderP1.exe' } else { $null }

[PSCustomObject]@{
  detectedAt = [DateTime]::UtcNow.ToString('o')
  applications = @(
    (App 'obs' $obsPath $obsProcess $obsEntry)
    (App 'p1' $p1Path $p1Process $p1Entry)
  )
} | ConvertTo-Json -Depth 5 -Compress
`;
