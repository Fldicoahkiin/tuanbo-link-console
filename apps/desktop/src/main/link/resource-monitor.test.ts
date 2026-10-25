import { describe, expect, it } from 'vitest';
import { ResourceMonitor, type AppProcessMetric } from './resource-monitor';

type Entry = { level: string; message: string; details: Record<string, unknown> };

function setup(options: { handles?: (pids: number[]) => Promise<Map<number, number | null>>; extra?: Array<{ pid: number; label: string }> } = {}) {
  let time = 0; let rendererHandles = 420; let rendererPrivateKb = 200 * 1024; let rendererPid = 20;
  const entries: Entry[] = [];
  const metrics = (): AppProcessMetric[] => [
    { pid: 10, type: 'Browser', cpu: { percentCPUUsage: 6.04 }, memory: { workingSetSize: 250 * 1024, privateBytes: 230 * 1024 } },
    { pid: rendererPid, type: 'Tab', cpu: { percentCPUUsage: 15 }, memory: { workingSetSize: 260 * 1024, privateBytes: rendererPrivateKb } },
    { pid: 30, type: 'Utility', name: 'Audio Service', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 10 * 1024 } }
  ];
  const monitor = new ResourceMonitor({
    metrics, extra: () => options.extra ?? [], now: () => time, warmupMs: 600_000,
    handles: options.handles ?? (pids => Promise.resolve(new Map(pids.map(pid => [pid, pid === rendererPid ? rendererHandles : 1167])))),
    record: entry => { entries.push(entry); return Promise.resolve(); }
  });
  return { monitor, entries, advance: (ms: number) => { time += ms; },
    set: (values: { handles?: number; privateMB?: number; pid?: number }) => {
      if (values.handles !== undefined) rendererHandles = values.handles;
      if (values.privateMB !== undefined) rendererPrivateKb = values.privateMB * 1024;
      if (values.pid !== undefined) rendererPid = values.pid;
    } };
}

describe('资源采样', () => {
  it('每次记录各进程的内存、CPU 和句柄，摘要只写主要进程', async () => {
    const { monitor, entries } = setup({ extra: [{ pid: 40, label: '播放引擎' }] });
    const samples = await monitor.sample();
    expect(samples.find(item => item.pid === 20)).toEqual({ pid: 20, label: '界面', privateMB: 200, workingSetMB: 260, cpuPercent: 15, handles: 420 });
    expect(samples.find(item => item.pid === 30)?.label).toBe('Utility Audio Service');
    expect(samples.find(item => item.pid === 40)).toMatchObject({ label: '播放引擎', handles: 1167 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe('info');
    expect(entries[0]!.message).toBe('资源采样：主进程 230 MB / 1167 句柄 · 界面 200 MB / 420 句柄 · 播放引擎 1167 句柄');
  });

  it('启动稳定后的数值作基准，明显上涨记一次警告，再翻倍才再提醒', async () => {
    const { monitor, entries, advance, set } = setup();
    await monitor.sample();
    set({ handles: 5000 }); await monitor.sample();
    expect(entries.filter(entry => entry.level === 'warning')).toHaveLength(0); // still warming up
    set({ handles: 420 }); advance(600_000); await monitor.sample(); // baseline
    set({ handles: 1419 }); advance(600_000); await monitor.sample();
    expect(entries.filter(entry => entry.level === 'warning')).toHaveLength(0);
    set({ handles: 1420 }); advance(600_000); await monitor.sample();
    const warnings = () => entries.filter(entry => entry.level === 'warning');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.message).toContain('界面句柄比启动稳定后多了 1000（420 → 1420）');
    set({ handles: 2000 }); await monitor.sample();
    expect(warnings()).toHaveLength(1);
    set({ handles: 2420 }); await monitor.sample();
    expect(warnings()).toHaveLength(2);
  });

  it('内存上涨 1 GB 也提醒', async () => {
    const { monitor, entries, advance, set } = setup();
    advance(600_000); await monitor.sample();
    set({ privateMB: 1224 }); await monitor.sample();
    expect(entries.filter(entry => entry.level === 'warning').map(entry => entry.message)).toEqual([expect.stringContaining('界面内存比启动稳定后多了 1024 MB（200 MB → 1224 MB）')]);
  });

  it('界面重新加载后是新进程，重新取基准', async () => {
    const { monitor, entries, advance, set } = setup();
    advance(600_000); await monitor.sample();
    set({ pid: 21, handles: 3000 }); await monitor.sample();
    set({ handles: 3500 }); await monitor.sample();
    expect(entries.filter(entry => entry.level === 'warning')).toHaveLength(0);
  });

  it('读不到句柄数时照样记内存，并只警告一次', async () => {
    const { monitor, entries } = setup({ handles: () => Promise.reject(new Error('进程识别组件运行失败')) });
    await monitor.sample(); await monitor.sample();
    expect(entries.filter(entry => entry.level === 'warning').map(entry => entry.message)).toEqual(['资源采样读不到句柄数：进程识别组件运行失败']);
    expect(entries.filter(entry => entry.level === 'info')[1]!.message).toContain('界面 200 MB / ? 句柄');
  });
});
