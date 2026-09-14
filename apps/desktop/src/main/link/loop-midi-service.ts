import { dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { loopMidiStatusSchema, type LoopMidiStatus } from '@tb/schema';
import { executePowerShell } from './windows-integration-detector';
import { WindowsProcessTools, type ExternalProcessTools } from './external-process-manager';

export class LoopMidiService {
  private starting: Promise<LoopMidiStatus> | null = null;
  private child: ChildProcess | null = null;
  constructor(
    private readonly discover: () => Promise<LoopMidiStatus> = async () => loopMidiStatusSchema.parse(JSON.parse(await executePowerShell(DISCOVERY, 15_000))),
    private readonly tools: ExternalProcessTools = new WindowsProcessTools()
  ) {}

  detect(): Promise<LoopMidiStatus> { return this.discover(); }

  start(): Promise<LoopMidiStatus> {
    if (this.starting) return this.starting;
    this.starting = this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(): Promise<LoopMidiStatus> {
    const status = await this.detect();
    if (status.state === 'running' || !status.executablePath) return status;
    const path = status.executablePath;
    const matches = await this.tools.findByExecutable(path);
    if (matches.length > 1) throw new Error('发现多个 loopMIDI 进程，请先确认保留的实例');
    const existing = matches[0];
    if (existing) return { state: 'running', executablePath: path, pid: existing.pid, startTime: existing.startTime };
    if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
      throw new Error('上次启动的 loopMIDI 尚未退出且无法核验，拒绝重复启动；请重新检测');
    }
    const child = this.tools.launch({ executablePath: path, workingDirectory: dirname(path), arguments: [], startupTimeoutMs: 15_000, shutdownTimeoutMs: 10_000 });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    this.child = child;
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const process = (await this.tools.findByExecutable(path)).find((entry) => entry.pid === child.pid);
      if (process) return { state: 'running', executablePath: path, pid: process.pid, startTime: process.startTime };
      if (child.exitCode !== null) throw new Error('loopMIDI 在启动确认前退出，请重新检测');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('loopMIDI 启动确认超时，已保留进程，请重新检测；不会自动重试');
  }
}

const DISCOVERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'loopMIDI.exe' })
if ($processes.Count -gt 1) { throw '发现多个 loopMIDI 进程，请先确认保留的实例' }
$path = $null
$pidValue = $null
$started = $null
if ($processes.Count -eq 1) {
  $path = $processes[0].ExecutablePath
  if (-not $path) { throw '无法核验 loopMIDI 进程路径，请检查运行权限' }
  $pidValue = [int]$processes[0].ProcessId
  $started = (Get-Process -Id $pidValue -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
} else {
  $entries = @(Get-ItemProperty -Path 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^loopMIDI(\s|$)' })
  $candidates = @(
    foreach ($entry in $entries) {
      if ($entry.InstallLocation) { Join-Path $entry.InstallLocation 'loopMIDI.exe' }
      if ($entry.DisplayIcon) { (([string]$entry.DisplayIcon) -replace ',\s*-?\d+$','').Trim('"') }
    }
    if ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) { Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Tobias Erichsen\loopMIDI\loopMIDI.exe' }
    if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Tobias Erichsen\loopMIDI\loopMIDI.exe' }
  )
  $valid = @($candidates | Where-Object { $_ -and [IO.Path]::GetFileName($_) -ieq 'loopMIDI.exe' -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
  if ($valid.Count -gt 1) { throw '检测到多个 loopMIDI 安装位置，请先启动需要使用的版本再检测' }
  if ($valid.Count -eq 1) { $path = [IO.Path]::GetFullPath($valid[0]) }
}
[PSCustomObject]@{ state=$(if ($pidValue) { 'running' } elseif ($path) { 'installed' } else { 'missing' }); executablePath=$path; pid=$pidValue; startTime=$started } | ConvertTo-Json -Compress
`;
