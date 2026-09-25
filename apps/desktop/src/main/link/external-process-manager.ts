import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { windowsPowerShellExecutable } from './windows-powershell';

export type ExternalApplicationId = 'obs' | 'p1';
export type ExternalProcessStatus = 'notRunning' | 'starting' | 'running' | 'reconnecting' | 'stopping' | 'error';

export type ExternalProcessConfiguration = {
  executablePath: string;
  arguments: string[];
  workingDirectory: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  environment?: Record<string, string>;
};

export type DetectedProcess = {
  pid: number;
  processName: string;
  executablePath: string;
  startTime: string;
  windowTitle: string;
  fileVersion: string;
};

export type ManagedProcessSnapshot = {
  id: ExternalApplicationId;
  status: ExternalProcessStatus;
  pid: number | null;
  processName: string | null;
  executablePath: string | null;
  startTime: string | null;
  windowTitle: string | null;
  fileVersion: string | null;
  owned: boolean;
  error: string | null;
};

export type ExternalProcessTools = {
  findByExecutable(executablePath: string): Promise<DetectedProcess[]>;
  launch(configuration: ExternalProcessConfiguration): ChildProcess;
  requestClose(pid: number, identity?: Pick<ManagedProcessSnapshot, 'executablePath' | 'startTime'>): Promise<boolean>;
};

export type ObsActivityReader = {
  readOutputStatus(): Promise<{ streaming: boolean; recording: boolean }>;
};

type ProcessListener = (snapshot: ManagedProcessSnapshot) => void;

export class ExternalProcessManager {
  private readonly entries = new Map<ExternalApplicationId, {
    snapshot: ManagedProcessSnapshot;
    child: ChildProcess | null;
  }>();
  private readonly listeners = new Set<ProcessListener>();

  constructor(
    private readonly tools: ExternalProcessTools,
    private readonly obsActivity: ObsActivityReader
  ) {
    for (const id of ['obs', 'p1'] as const) {
      this.entries.set(id, {
        snapshot: emptySnapshot(id),
        child: null
      });
    }
  }

  subscribe(listener: ProcessListener): () => void {
    this.listeners.add(listener);
    for (const entry of this.entries.values()) listener({ ...entry.snapshot });
    return () => this.listeners.delete(listener);
  }

  getSnapshot(id: ExternalApplicationId): ManagedProcessSnapshot {
    return { ...this.getEntry(id).snapshot };
  }

  async start(id: ExternalApplicationId, configuration: ExternalProcessConfiguration): Promise<ManagedProcessSnapshot> {
    const current = this.getEntry(id);
    const executablePath = resolve(configuration.executablePath);
    const matches = await this.tools.findByExecutable(executablePath);
    const existingProcess = selectDetectedProcess(id, matches, current.snapshot.pid, '连接目标');
    if (existingProcess) {
      const process = existingProcess;
      const stillOwned = current.snapshot.owned && current.snapshot.pid === process.pid && current.snapshot.startTime === process.startTime;
      this.setEntry(id, processSnapshot(id, process, stillOwned, 'running'), stillOwned ? current.child : null);
      return this.getSnapshot(id);
    }
    if (hasLiveOwnedChild(current)) {
      const message = `${id} 已由联动台启动（PID ${String(current.snapshot.pid)}），但当前无法通过路径核验；拒绝重复启动`;
      this.setEntry(id, { ...current.snapshot, status: 'error', error: message }, current.child);
      throw new Error(message);
    }

    this.setEntry(id, {
      ...emptySnapshot(id),
      status: current.snapshot.status === 'error' ? 'reconnecting' : 'starting',
      executablePath,
      error: null
    }, null);

    let child: ChildProcess | null = null;
    try {
      child = this.tools.launch({ ...configuration, executablePath });
      await waitForSpawn(child, id);
      if (child.pid === undefined) throw new Error(`${id} 启动后未返回 PID`);
      const pid = child.pid;
      this.attachExitListener(id, child, pid);
      this.setEntry(id, {
        ...this.getSnapshot(id),
        pid,
        owned: true
      }, child);

      const process = await waitForExactProcess(this.tools, executablePath, pid, configuration.startupTimeoutMs);
      this.setEntry(id, processSnapshot(id, process, true, 'running'), child);
      return this.getSnapshot(id);
    } catch (error) {
      const current = this.getSnapshot(id);
      this.setEntry(id, {
        ...current,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      }, child);
      throw error;
    }
  }

  async refresh(
    id: ExternalApplicationId,
    configuration?: ExternalProcessConfiguration
  ): Promise<ManagedProcessSnapshot> {
    const current = this.getEntry(id);
    const executablePath = current.snapshot.executablePath
      ?? (configuration ? resolve(configuration.executablePath) : null);
    if (!executablePath) return this.getSnapshot(id);
    const matches = await this.tools.findByExecutable(executablePath);
    const match = selectDetectedProcess(id, matches, current.snapshot.pid, '监测目标');
    if (!match) {
      const wasRunning = current.snapshot.pid !== null || current.snapshot.status === 'running';
      if (hasLiveOwnedChild(current)) {
        this.setEntry(id, {
          ...current.snapshot,
          executablePath,
          status: 'error',
          error: '本次启动的进程暂时无法通过路径核验；已保留所有权，可请求正常关闭'
        }, current.child);
      } else {
        this.setEntry(id, {
          ...emptySnapshot(id),
          executablePath,
          status: current.snapshot.status === 'stopping' || !wasRunning ? 'notRunning' : 'error',
          error: current.snapshot.status === 'stopping' || !wasRunning ? null : '进程已退出'
        }, null);
      }
      return this.getSnapshot(id);
    }
    const stillOwned = current.snapshot.owned && current.snapshot.pid === match.pid && current.snapshot.startTime === match.startTime;
    this.setEntry(id, processSnapshot(id, match, stillOwned, 'running'), stillOwned ? current.child : null);
    return this.getSnapshot(id);
  }

  async stop(id: ExternalApplicationId, timeoutMs: number): Promise<ManagedProcessSnapshot> {
    const entry = this.getEntry(id);
    if (!entry.snapshot.owned) {
      throw new Error(`${id} 不是本次由联动台启动的进程，拒绝关闭`);
    }
    if (entry.snapshot.pid === null) return this.getSnapshot(id);
    if (id === 'obs') {
      const activity = await this.obsActivity.readOutputStatus();
      if (activity.streaming || activity.recording) {
        throw new Error('OBS 正在推流或录像，拒绝关闭');
      }
    }

    const pid = entry.snapshot.pid;
    this.setEntry(id, { ...entry.snapshot, status: 'stopping', error: null }, entry.child);
    const accepted = await this.tools.requestClose(pid, entry.snapshot);
    if (!accepted) {
      this.setEntry(id, { ...this.getSnapshot(id), status: 'running', error: '程序拒绝正常关闭请求' }, entry.child);
      throw new Error(`${id} 没有接受正常关闭请求，进程保持运行`);
    }

    const exited = await waitForExit(entry.child, pid, entry.snapshot, timeoutMs);
    if (!exited) {
      this.setEntry(id, { ...this.getSnapshot(id), status: 'running', error: '正常关闭超时，进程保持运行' }, entry.child);
      throw new Error(`${id} 正常关闭超时，未强制结束进程`);
    }
    this.setEntry(id, emptySnapshot(id), null);
    return this.getSnapshot(id);
  }

  async stopOwnedInOrder(configurations: Record<ExternalApplicationId, ExternalProcessConfiguration>): Promise<void> {
    for (const id of ['p1', 'obs'] as const) {
      const entry = this.getEntry(id);
      if (!entry.snapshot.owned || entry.snapshot.pid === null) continue;
      await this.stopWithTimeout(id, configurations[id].shutdownTimeoutMs);
    }
  }

  private async stopWithTimeout(id: ExternalApplicationId, timeoutMs: number): Promise<void> {
    const entry = this.getEntry(id);
    if (entry.snapshot.pid === null) return;
    if (id === 'obs') {
      const activity = await this.obsActivity.readOutputStatus();
      if (activity.streaming || activity.recording) throw new Error('OBS 正在推流或录像，拒绝关闭');
    }
    this.setEntry(id, { ...entry.snapshot, status: 'stopping', error: null }, entry.child);
    const accepted = await this.tools.requestClose(entry.snapshot.pid, entry.snapshot);
    if (!accepted) throw new Error(`${id} 没有接受正常关闭请求，进程保持运行`);
    const exited = await waitForExit(entry.child, entry.snapshot.pid, entry.snapshot, timeoutMs);
    if (!exited) throw new Error(`${id} 正常关闭超时，未强制结束进程`);
    this.setEntry(id, emptySnapshot(id), null);
  }

  private attachExitListener(id: ExternalApplicationId, child: ChildProcess, pid: number): void {
    child.once('exit', (code, signal) => {
      const entry = this.getEntry(id);
      if (entry.snapshot.pid !== pid) return;
      const expected = entry.snapshot.status === 'stopping';
      this.setEntry(id, {
        ...entry.snapshot,
        status: expected ? 'notRunning' : 'error',
        pid: null,
        owned: false,
        error: expected ? null : `进程异常退出（code=${String(code)}, signal=${String(signal)}）`
      }, null);
    });
  }

  private getEntry(id: ExternalApplicationId): { snapshot: ManagedProcessSnapshot; child: ChildProcess | null } {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`未知外部程序：${id}`);
    return entry;
  }

  private setEntry(id: ExternalApplicationId, snapshot: ManagedProcessSnapshot, child: ChildProcess | null): void {
    this.entries.set(id, { snapshot, child });
    const copy = { ...snapshot };
    for (const listener of this.listeners) listener(copy);
  }
}

function hasLiveOwnedChild(entry: { snapshot: ManagedProcessSnapshot; child: ChildProcess | null }): entry is {
  snapshot: ManagedProcessSnapshot & { pid: number; owned: true };
  child: ChildProcess;
} {
  return entry.snapshot.owned
    && entry.snapshot.pid !== null
    && entry.child !== null
    && entry.child.exitCode === null;
}

function selectDetectedProcess(
  id: ExternalApplicationId,
  matches: readonly DetectedProcess[],
  trackedPid: number | null,
  purpose: string
): DetectedProcess | null {
  if (trackedPid !== null) {
    const tracked = matches.find((candidate) => candidate.pid === trackedPid);
    if (tracked) return tracked;
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  const withMainWindow = matches.filter((candidate) => candidate.windowTitle.trim() !== '');
  if (withMainWindow.length === 1) return withMainWindow[0] ?? null;
  throw new Error(`${id} 存在多个相同路径进程且无法由唯一主窗口确定${purpose}`);
}

export class WindowsProcessTools implements ExternalProcessTools {
  async findByExecutable(executablePath: string): Promise<DetectedProcess[]> {
    const encodedPath = Buffer.from(resolve(executablePath), 'utf16le').toString('base64');
    const script = [
      `$target=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
      '$target=[IO.Path]::GetFullPath($target)',
      "$items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($target,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { try { $p=Get-Process -Id $_.ProcessId -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){ return }; throw }; $info=(Get-Item -LiteralPath $_.ExecutablePath -ErrorAction Stop).VersionInfo; $version=if($info.FileVersion){$info.FileVersion}elseif($info.ProductVersion){$info.ProductVersion}else{''}; if(-not $version){$directory=[IO.Path]::GetDirectoryName($_.ExecutablePath).TrimEnd('\\'); $uninstallEntries=@(Get-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue); $match=$uninstallEntries | Where-Object { $_.InstallLocation -and [IO.Path]::GetFullPath($_.InstallLocation).TrimEnd('\\').Equals($directory,[StringComparison]::OrdinalIgnoreCase) -and $_.DisplayVersion } | Select-Object -First 1; if($match){$version=[string]$match.DisplayVersion}}; [PSCustomObject]@{ pid=[int]$_.ProcessId; processName=$_.Name; executablePath=$_.ExecutablePath; startTime=$p.StartTime.ToUniversalTime().ToString('o'); windowTitle=[string]$p.MainWindowTitle; fileVersion=[string]$version } })",
      '$items | ConvertTo-Json -Compress'
    ].join(';');
    const output = await runPowerShell(script, 10_000);
    if (output.trim() === '') return [];
    return parseDetectedProcesses(JSON.parse(output));
  }

  launch(configuration: ExternalProcessConfiguration): ChildProcess {
    const child = spawn(configuration.executablePath, configuration.arguments, {
      cwd: configuration.workingDirectory,
      env: { ...process.env, ...configuration.environment },
      windowsHide: false,
      stdio: 'ignore'
    });
    // Retain the child handle for ownership checks while the desktop runs,
    // but do not let a preserved OBS/P1 process keep Electron alive after exit.
    child.unref();
    return child;
  }

  async requestClose(pid: number, identity?: Pick<ManagedProcessSnapshot, 'executablePath' | 'startTime'>): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`非法 PID：${pid}`);
    if (!identity?.executablePath || !identity.startTime) throw new Error('无法核验进程路径与启动时间，拒绝关闭');
    const path = Buffer.from(resolve(identity.executablePath), 'utf16le').toString('base64');
    const started = Buffer.from(identity.startTime, 'utf16le').toString('base64');
    const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $expected=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${path}')); $started=[DateTime]::Parse([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${started}'))).ToUniversalTime(); if(-not $p.MainModule.FileName.Equals($expected,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime() -ne $started){throw '进程身份已变化，拒绝关闭'}; $p.CloseMainWindow()`;
    return (await runPowerShell(script, 10_000)).trim().toLowerCase() === 'true';
  }
}

function emptySnapshot(id: ExternalApplicationId): ManagedProcessSnapshot {
  return {
    id,
    status: 'notRunning',
    pid: null,
    processName: null,
    executablePath: null,
    startTime: null,
    windowTitle: null,
    fileVersion: null,
    owned: false,
    error: null
  };
}

function processSnapshot(
  id: ExternalApplicationId,
  process: DetectedProcess,
  owned: boolean,
  status: ExternalProcessStatus
): ManagedProcessSnapshot {
  return {
    id,
    status,
    pid: process.pid,
    processName: process.processName,
    executablePath: process.executablePath,
    startTime: process.startTime,
    windowTitle: process.windowTitle,
    fileVersion: process.fileVersion,
    owned,
    error: null
  };
}

async function waitForExactProcess(
  tools: ExternalProcessTools,
  executablePath: string,
  pid: number,
  timeoutMs: number
): Promise<DetectedProcess> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const matches = await tools.findByExecutable(executablePath);
    const match = matches.find((candidate) => candidate.pid === pid);
    if (match) return match;
    await delay(250);
  }
  throw new Error(`进程 ${pid} 在 ${timeoutMs}ms 内未通过路径核验`);
}

function waitForSpawn(child: ChildProcess, id: ExternalApplicationId): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => reject(new Error(`${id} 启动失败：${error.message}`, { cause: error })));
  });
}

async function waitForExit(
  child: ChildProcess | null,
  pid: number,
  snapshot: ManagedProcessSnapshot,
  timeoutMs: number
): Promise<boolean> {
  if (child === null) throw new Error(`无法等待非本次启动的进程 ${pid} 退出`);
  if (child.exitCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
    if (!snapshot.owned) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const executable = await windowsPowerShellExecutable();
  const encoded = Buffer.from([
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)',
    '$OutputEncoding=[Text.UTF8Encoding]::new($false)',
    script
  ].join(';'), 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
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
      reject(new Error(`PowerShell 进程检测超过 ${timeoutMs}ms`));
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
        reject(new Error(`PowerShell 进程检测失败（${String(code)}）：${errorOutput}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

function parseDetectedProcesses(value: unknown): DetectedProcess[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((candidate) => {
    if (!isDetectedProcess(candidate)) throw new Error('Windows 进程检测返回了无效数据');
    return candidate;
  });
}

function isDetectedProcess(value: unknown): value is DetectedProcess {
  if (typeof value !== 'object' || value === null) return false;
  return 'pid' in value && typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0
    && 'processName' in value && typeof value.processName === 'string' && value.processName.length > 0
    && 'executablePath' in value && typeof value.executablePath === 'string'
    && 'startTime' in value && typeof value.startTime === 'string'
    && 'windowTitle' in value && typeof value.windowTitle === 'string'
    && 'fileVersion' in value && typeof value.fileVersion === 'string';
}
