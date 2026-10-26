import { spawn, type ChildProcess } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import type { ProcessAccess } from './process-identity';
import { windowsPowerShellExecutable } from './windows-powershell';

export type ExternalApplicationId = 'obs' | 'p1' | 'ma2' | 'ma3d';
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
  access: ProcessAccess;
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
  /** PIDs in this Windows session with the same file name that cannot be identified at all, so neither verified nor safely duplicated. */
  findUnverifiable(executablePath: string): Promise<number[]>;
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
  private readonly access = new Map<ExternalApplicationId, { pid: number; startTime: string; access: ProcessAccess }>();

  constructor(
    private readonly tools: ExternalProcessTools,
    private readonly obsActivity: ObsActivityReader
  ) {
    for (const id of ['obs', 'p1', 'ma2', 'ma3d'] as const) {
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

  /** How the current process was identified, or null when none is tracked. 'limited' is usually a program
   * running as administrator: some details, such as its command line, need the bundled reader. */
  inspectionAccess(id: ExternalApplicationId): ProcessAccess | null {
    const { snapshot } = this.getEntry(id);
    const known = this.access.get(id);
    return known && snapshot.pid === known.pid && snapshot.startTime === known.startTime ? known.access : null;
  }

  async start(id: ExternalApplicationId, configuration: ExternalProcessConfiguration): Promise<ManagedProcessSnapshot> {
    const current = this.getEntry(id);
    const executablePath = resolve(configuration.executablePath);
    const matches = await this.tools.findByExecutable(executablePath);
    const existingProcess = selectDetectedProcess(id, matches, current.snapshot.pid, '连接目标');
    if (existingProcess) {
      const process = existingProcess;
      const stillOwned = current.snapshot.owned && current.snapshot.pid === process.pid && current.snapshot.startTime === process.startTime;
      this.adopt(id, process, stillOwned, stillOwned ? current.child : null);
      if ((id === 'ma2' || id === 'ma3d') && !process.windowTitle) {
        const message = `${id === 'ma2' ? 'MA2 onPC' : 'MA 3D'} 已经在运行，但主窗口还没出现。请先处理它的残留进程或启动提示，再重新连接（没有再启动一个）`;
        this.setEntry(id, { ...this.getSnapshot(id), status: 'error', error: message }, stillOwned ? current.child : null);
        throw new Error(message);
      }
      return this.getSnapshot(id);
    }
    if (hasLiveOwnedChild(current)) {
      const message = `${id} 已由联动台启动（PID ${String(current.snapshot.pid)}），但现在无法确认它的程序路径，没有再启动一个`;
      this.setEntry(id, { ...current.snapshot, status: 'error', error: message }, current.child);
      throw new Error(message);
    }
    await this.assertNoUnverifiableInstance(id, executablePath);

    this.setEntry(id, {
      ...emptySnapshot(id),
      status: current.snapshot.status === 'error' ? 'reconnecting' : 'starting',
      executablePath,
      error: null
    }, null);

    let child: ChildProcess | null = null;
    try {
      child = this.tools.launch({ ...configuration, executablePath });
      await waitForSpawn(child, id, executablePath);
      if (child.pid === undefined) throw new Error(`${id} 启动后没有拿到进程号`);
      const pid = child.pid;
      this.attachExitListener(id, child, pid);
      this.setEntry(id, {
        ...this.getSnapshot(id),
        pid,
        owned: true
      }, child);

      const process = await waitForExactProcess(this.tools, executablePath, pid, configuration.startupTimeoutMs, id === 'ma2' || id === 'ma3d');
      this.adopt(id, process, true, child);
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

  /** Call before launching or maintaining a program that was not found by path. An instance we cannot
   * inspect can be neither verified nor safely duplicated, so stop with the reason instead. */
  async assertNoUnverifiableInstance(id: ExternalApplicationId, executablePath: string): Promise<void> {
    const path = resolve(executablePath);
    const pids = await this.tools.findUnverifiable(path);
    if (pids.length === 0) return;
    const message = unverifiableInstanceMessage(id, pids);
    this.setEntry(id, { ...emptySnapshot(id), executablePath: path, status: 'error', error: message }, null);
    throw new Error(message);
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
          error: '暂时无法确认这次启动的程序路径，仍由联动台管理，可以请求正常关闭'
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
    this.adopt(id, match, stillOwned, stillOwned ? current.child : null);
    return this.getSnapshot(id);
  }

  async stop(id: ExternalApplicationId, timeoutMs: number): Promise<ManagedProcessSnapshot> {
    const entry = this.getEntry(id);
    if (!entry.snapshot.owned) {
      throw new Error(`${id} 不是这次由联动台启动的，联动台不会关闭它`);
    }
    if (entry.snapshot.pid === null) return this.getSnapshot(id);
    if (id === 'obs') {
      const activity = await this.obsActivity.readOutputStatus();
      if (activity.streaming || activity.recording) {
        throw new Error('OBS 正在推流或录像，联动台不会关闭它');
      }
    }

    const pid = entry.snapshot.pid;
    this.setEntry(id, { ...entry.snapshot, status: 'stopping', error: null }, entry.child);
    const accepted = await this.tools.requestClose(pid, entry.snapshot);
    if (!accepted) {
      this.setEntry(id, { ...this.getSnapshot(id), status: 'running', error: '程序拒绝了关闭请求' }, entry.child);
      throw new Error(`${id} 没有接受关闭请求，仍在运行`);
    }

    const exited = await waitForExit(entry.child, pid, entry.snapshot, timeoutMs);
    if (!exited) {
      this.setEntry(id, { ...this.getSnapshot(id), status: 'running', error: '关闭超时，程序仍在运行' }, entry.child);
      throw new Error(`${id} 关闭超时，联动台没有强制结束它`);
    }
    this.setEntry(id, emptySnapshot(id), null);
    return this.getSnapshot(id);
  }

  async stopOwnedInOrder(configurations: Record<'obs' | 'p1', ExternalProcessConfiguration> & Partial<Record<'ma2' | 'ma3d', ExternalProcessConfiguration>>): Promise<void> {
    for (const id of ['p1', 'ma3d', 'ma2', 'obs'] as const) {
      const entry = this.getEntry(id);
      if (!entry.snapshot.owned || entry.snapshot.pid === null) continue;
      const configuration = configurations[id];
      if (!configuration) throw new Error(`${id} 缺少启动设置，程序仍在运行`);
      await this.stopWithTimeout(id, configuration.shutdownTimeoutMs);
    }
  }

  private async stopWithTimeout(id: ExternalApplicationId, timeoutMs: number): Promise<void> {
    const entry = this.getEntry(id);
    if (entry.snapshot.pid === null) return;
    if (id === 'obs') {
      const activity = await this.obsActivity.readOutputStatus();
      if (activity.streaming || activity.recording) throw new Error('OBS 正在推流或录像，联动台不会关闭它');
    }
    this.setEntry(id, { ...entry.snapshot, status: 'stopping', error: null }, entry.child);
    const accepted = await this.tools.requestClose(entry.snapshot.pid, entry.snapshot);
    if (!accepted) throw new Error(`${id} 没有接受关闭请求，仍在运行`);
    const exited = await waitForExit(entry.child, entry.snapshot.pid, entry.snapshot, timeoutMs);
    if (!exited) throw new Error(`${id} 关闭超时，联动台没有强制结束它`);
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

  private adopt(id: ExternalApplicationId, process: DetectedProcess, owned: boolean, child: ChildProcess | null): void {
    this.access.set(id, { pid: process.pid, startTime: process.startTime, access: process.access });
    this.setEntry(id, processSnapshot(id, process, owned, 'running'), child);
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
  throw new Error(`${id} 同时开了多个，无法确定哪一个是${purpose}`);
}

export class WindowsProcessTools implements ExternalProcessTools {
  /** identityHelper is the bundled reader for processes Windows hides from this console, usually ones
   * running as administrator. Without it such processes are only reported by findUnverifiable. */
  constructor(private readonly identityHelper: string | null = null) {}

  async findByExecutable(executablePath: string): Promise<DetectedProcess[]> {
    const script = [
      processCandidatesScript(executablePath, this.identityHelper),
      "function Get-TbVersion([string]$path) { $info=(Get-Item -LiteralPath $path -ErrorAction Stop).VersionInfo; $version=if($info.FileVersion){$info.FileVersion}elseif($info.ProductVersion){$info.ProductVersion}else{''}; if(-not $version){$directory=[IO.Path]::GetDirectoryName($path).TrimEnd('\\'); $uninstallEntries=@(Get-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue); $match=$uninstallEntries | Where-Object { $_.InstallLocation -and [IO.Path]::GetFullPath($_.InstallLocation).TrimEnd('\\').Equals($directory,[StringComparison]::OrdinalIgnoreCase) -and $_.DisplayVersion } | Select-Object -First 1; if($match){$version=[string]$match.DisplayVersion}}; [string]$version }",
      "$items=@($all | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).Equals($target,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { try { $p=Get-Process -Id $_.ProcessId -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){ return }; throw }; [PSCustomObject]@{ pid=[int]$_.ProcessId; processName=$_.Name; executablePath=$_.ExecutablePath; startTime=$p.StartTime.ToUniversalTime().ToString('o'); windowTitle=[string]$p.MainWindowTitle; fileVersion=(Get-TbVersion $_.ExecutablePath); access='full' } })",
      // The reader gives a hidden process's real path and creation time; Windows still shares its main window title.
      "if($helper -and $hidden.Count -gt 0){ foreach($identity in @(Read-TbIdentity)){ if(-not $identity.path -or -not [IO.Path]::GetFullPath($identity.path).Equals($target,[StringComparison]::OrdinalIgnoreCase)){ continue }; try { $p=Get-Process -Id ([int]$identity.pid) -ErrorAction Stop } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){ continue }; throw }; $items+=[PSCustomObject]@{ pid=[int]$identity.pid; processName=[IO.Path]::GetFileName($identity.path); executablePath=[string]$identity.path; startTime=[DateTime]::FromFileTimeUtc([long]$identity.creationTime).ToString('o'); windowTitle=[string]$p.MainWindowTitle; fileVersion=(Get-TbVersion $identity.path); access='limited' } } }",
      '$items | ConvertTo-Json -Compress'
    ].join(';');
    const output = await runPowerShell(script, 10_000);
    if (output.trim() === '') return [];
    return parseDetectedProcesses(JSON.parse(output));
  }

  async findUnverifiable(executablePath: string): Promise<number[]> {
    const script = [
      processCandidatesScript(executablePath, this.identityHelper),
      // With the reader only the candidates it cannot open stay unverifiable, for example one started under another Windows account.
      '$ids=@(if($helper -and $hidden.Count -gt 0){ foreach($identity in @(Read-TbIdentity)){ if(-not $identity.path){ [int]$identity.pid } } } else { foreach($process in $hidden){ [int]$process.ProcessId } })',
      'ConvertTo-Json -Compress -InputObject $ids'
    ].join(';');
    const output = await runPowerShell(script, 10_000);
    return pidListSchema.parse(JSON.parse(output));
  }

  launch(configuration: ExternalProcessConfiguration): ChildProcess {
    const child = spawn(configuration.executablePath, configuration.arguments, {
      cwd: configuration.workingDirectory,
      env: { ...process.env, ...configuration.environment },
      detached: true,
      windowsHide: false,
      stdio: 'ignore'
    });
    // Give external apps an independent lifetime so choosing to preserve them
    // survives Electron exit; retain their handle for exact ownership checks.
    child.unref();
    return child;
  }

  async requestClose(pid: number, identity?: Pick<ManagedProcessSnapshot, 'executablePath' | 'startTime'>): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`非法 PID：${pid}`);
    if (!identity?.executablePath || !identity.startTime) throw new Error('无法确认程序的路径和启动时间，联动台不会关闭它');
    const path = Buffer.from(resolve(identity.executablePath), 'utf16le').toString('base64');
    const started = Buffer.from(identity.startTime, 'utf16le').toString('base64');
    const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $expected=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${path}')); $started=[DateTime]::Parse([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${started}'))).ToUniversalTime(); if(-not $p.MainModule.FileName.Equals($expected,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime() -ne $started){throw '进程身份已变化，拒绝关闭'}; $p.CloseMainWindow()`;
    return (await runPowerShell(script, 10_000)).trim().toLowerCase() === 'true';
  }
}

const utf16Base64 = (value: string): string => Buffer.from(value, 'utf16le').toString('base64');

/** Shared PowerShell prelude: the target path, every process, the same-name processes in this Windows
 * session whose path is hidden from us ($hidden), and Read-TbIdentity, which asks the bundled reader about them. */
function processCandidatesScript(executablePath: string, helper: string | null): string {
  return [
    `$target=[IO.Path]::GetFullPath([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16Base64(resolve(executablePath))}')))`,
    helper ? `$helper=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${utf16Base64(helper)}'))` : '$helper=$null',
    '$leaf=[IO.Path]::GetFileName($target)',
    '$session=[Diagnostics.Process]::GetCurrentProcess().SessionId',
    '$all=@(Get-CimInstance Win32_Process)',
    // A non-elevated caller sees elevated processes without ExecutablePath. Other sessions belong to other sign-ins.
    '$hidden=@($all | Where-Object { -not $_.ExecutablePath -and $_.SessionId -eq $session -and [string]::Equals($_.Name,$leaf,[StringComparison]::OrdinalIgnoreCase) })',
    "function Read-TbIdentity { if(-not (Test-Path -LiteralPath $helper -PathType Leaf)){ throw '缺少进程识别组件，请重新安装联动台' }; $raw=(& $helper @($hidden | ForEach-Object { [string][int]$_.ProcessId }) | Out-String); if($LASTEXITCODE -ne 0){ throw \"进程识别组件运行失败（$LASTEXITCODE）\" }; foreach($identity in (ConvertFrom-Json -InputObject $raw)){ $identity } }"
  ].join(';');
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
  timeoutMs: number,
  requireWindow = false
): Promise<DetectedProcess> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const matches = await tools.findByExecutable(executablePath);
    const match = matches.find((candidate) => candidate.pid === pid);
    if (match && (!requireWindow || match.windowTitle)) return match;
    await delay(250);
  }
  throw new Error(`进程 ${pid} 在 ${timeoutMs} ms 内${requireWindow ? '没有通过路径确认，或主窗口还没出现' : '没有通过路径确认'}`);
}

function waitForSpawn(child: ChildProcess, id: ExternalApplicationId, executablePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      // Node reports Windows ERROR_ELEVATION_REQUIRED as EACCES; the program is set to always run as administrator.
      const label = applicationLabels[id];
      const message = 'code' in error && error.code === 'EACCES'
        ? `${label} 启动失败：${basename(executablePath)} 被设置为总是以管理员身份运行，联动台不会提权启动程序。请自己打开 ${label}（以管理员身份也可以），然后回到联动台重新连接，联动台会识别并连接已运行的 ${label}。`
        : `${id} 启动失败：${error.message}`;
      reject(new Error(message, { cause: error }));
    });
  });
}

const applicationLabels: Record<ExternalApplicationId, string> = { obs: 'OBS', p1: 'P1', ma2: 'MA2 onPC', ma3d: 'MA 3D' };
const pidListSchema = z.array(z.number().int().positive());

function unverifiableInstanceMessage(id: ExternalApplicationId, pids: readonly number[]): string {
  const label = applicationLabels[id];
  return `${label} 已在运行（PID ${pids.join('、')}），但 Windows 不允许联动台检查这个进程，常见原因是它用另一个 Windows 账户打开（例如“以其他用户身份运行”，或以管理员身份运行时输入了另一个账户的密码）。联动台不会再启动一个 ${label}。请在 ${label} 里正常退出，再用当前 Windows 账户打开（以管理员身份也可以），然后重新连接。`;
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
      reject(new Error(`PowerShell 检测进程超时（${timeoutMs} ms）`));
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

const detectedProcessSchema = z.object({
  pid: z.number().int().positive(),
  processName: z.string().min(1),
  executablePath: z.string(),
  startTime: z.string(),
  windowTitle: z.string(),
  fileVersion: z.string(),
  access: z.enum(['full', 'limited'])
});

function parseDetectedProcesses(value: unknown): DetectedProcess[] {
  const parsed = z.array(detectedProcessSchema).safeParse(Array.isArray(value) ? value : [value]);
  if (!parsed.success) throw new Error('Windows 进程检测返回了无效数据', { cause: parsed.error });
  return parsed.data;
}
