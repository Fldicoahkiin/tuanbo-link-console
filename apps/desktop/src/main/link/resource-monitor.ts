/** One process as Electron reports it (memory in KB, as app.getAppMetrics() returns it). */
export type AppProcessMetric = {
  pid: number; type: string; name?: string | undefined;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number; privateBytes?: number | undefined };
};

export type ResourceSample = {
  pid: number; label: string; privateMB: number | null; workingSetMB: number | null; cpuPercent: number | null; handles: number | null;
};

type LogEntry = { level: 'info' | 'warning'; category: 'system'; device: string; message: string; details: Record<string, unknown> };

export type ResourceMonitorOptions = {
  metrics: () => AppProcessMetric[];
  /** Processes outside Electron's list, such as the native playback engine. */
  extra: () => Array<{ pid: number; label: string }>;
  /** Open handle counts by PID; a PID Windows does not answer for maps to null. */
  handles: (pids: number[]) => Promise<Map<number, number | null>>;
  record: (entry: LogEntry) => Promise<unknown>;
  now?: () => number;
  intervalMs?: number;
  /** Counts after start-up settles are the baseline that growth is measured from. */
  warmupMs?: number;
};

const LABELS: Record<string, string> = { Browser: '主进程', Tab: '界面', GPU: 'GPU' };
const HANDLE_STEP = 1000;
const MEMORY_STEP_MB = 1024;

type Baseline = { handles: number | null; privateMB: number | null; nextHandles: number; nextMemoryMB: number };

/** Writes each process's memory, CPU and handle count to the run log at a fixed interval, so a long show can be
 * read back from the log. Growth well past the settled baseline is logged once per doubling as a warning;
 * nothing is restarted or changed. */
export class ResourceMonitor {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly warmupMs: number;
  private readonly startedAt: number;
  private readonly baselines = new Map<string, Baseline>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private handleFailure: string | null = null;

  constructor(private readonly options: ResourceMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 600_000;
    this.warmupMs = options.warmupMs ?? 600_000;
    this.startedAt = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sample().catch((error: unknown) => console.error('资源采样失败', error));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sample(): Promise<ResourceSample[]> {
    const listed = this.options.metrics().map(metric => ({
      pid: metric.pid, label: LABELS[metric.type] ?? (metric.name ? `${metric.type} ${metric.name}` : metric.type),
      privateMB: metric.memory.privateBytes === undefined ? null : round(metric.memory.privateBytes / 1024),
      workingSetMB: round(metric.memory.workingSetSize / 1024), cpuPercent: round(metric.cpu.percentCPUUsage)
    }));
    const extra = this.options.extra().filter(entry => !listed.some(item => item.pid === entry.pid))
      .map(entry => ({ pid: entry.pid, label: entry.label, privateMB: null, workingSetMB: null, cpuPercent: null }));
    const processes = [...listed, ...extra];
    const counts = await this.readHandles(processes.map(item => item.pid));
    const samples: ResourceSample[] = processes.map(item => ({ ...item, handles: counts.get(item.pid) ?? null }));
    const warnings = this.now() - this.startedAt >= this.warmupMs ? this.compare(samples) : [];
    const summary = samples.filter(item => item.label in REVERSE_LABELS || extra.some(entry => entry.pid === item.pid))
      .map(item => { const memory = item.privateMB ?? item.workingSetMB; return `${item.label} ${memory === null ? '' : `${memory} MB / `}${item.handles ?? '?'} 句柄`; }).join(' · ');
    await this.options.record({ level: 'info', category: 'system', device: '资源', message: `资源采样：${summary || '无进程数据'}`,
      details: { uptimeMinutes: Math.round((this.now() - this.startedAt) / 60_000), processes: samples } });
    for (const warning of warnings) await this.options.record(warning);
    return samples;
  }

  private async readHandles(pids: number[]): Promise<Map<number, number | null>> {
    try {
      const counts = await this.options.handles(pids);
      this.handleFailure = null;
      return counts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Reported once until it works again; the memory figures are still logged.
      if (this.handleFailure !== message) {
        this.handleFailure = message;
        await this.options.record({ level: 'warning', category: 'system', device: '资源', message: `资源采样读不到句柄数：${message}`, details: { error: message } });
      }
      return new Map();
    }
  }

  private compare(samples: ResourceSample[]): LogEntry[] {
    const warnings: LogEntry[] = [];
    for (const sample of samples) {
      // A reloaded window or a new engine is a new process with its own baseline.
      const key = `${sample.label}:${sample.pid}`;
      const baseline = this.baselines.get(key);
      if (!baseline) {
        this.baselines.set(key, { handles: sample.handles, privateMB: sample.privateMB, nextHandles: HANDLE_STEP, nextMemoryMB: MEMORY_STEP_MB });
        continue;
      }
      if (baseline.handles !== null && sample.handles !== null && sample.handles - baseline.handles >= baseline.nextHandles) {
        warnings.push(growth(sample, '句柄', baseline.handles, sample.handles, ''));
        baseline.nextHandles *= 2;
      }
      if (baseline.privateMB !== null && sample.privateMB !== null && sample.privateMB - baseline.privateMB >= baseline.nextMemoryMB) {
        warnings.push(growth(sample, '内存', baseline.privateMB, sample.privateMB, ' MB'));
        baseline.nextMemoryMB *= 2;
      }
    }
    for (const key of [...this.baselines.keys()]) if (!samples.some(sample => `${sample.label}:${sample.pid}` === key)) this.baselines.delete(key);
    return warnings;
  }
}

const REVERSE_LABELS: Record<string, true> = Object.fromEntries(Object.values(LABELS).map(label => [label, true]));

function growth(sample: ResourceSample, what: string, from: number, to: number, unit: string): LogEntry {
  return { level: 'warning', category: 'system', device: '资源',
    message: `${sample.label}${what}比启动稳定后多了 ${round(to - from)}${unit}（${from}${unit} → ${to}${unit}），可能有资源没有释放。不影响当前播放，演出结束后请导出诊断包`,
    details: { pid: sample.pid, label: sample.label, what, from, to } };
}

function round(value: number): number { return Math.round(value * 10) / 10; }
