import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const resultSchema = z.enum(['ready', 'timeout', 'stopping', 'failed']);
export type MidiHealth = z.infer<typeof resultSchema>;
export function midiHealthMessage(result: MidiHealth): string {
  switch (result) {
    case 'ready': return 'MIDI 系统检测通过';
    case 'stopping': return 'Windows MIDI 服务正在停止，尚未释放 MIDI 连接。正常退出 MIDI 应用并恢复服务后点击“重新检测”；持续无法停止时需保存工作后重启 Windows。工程仍可编辑。';
    case 'timeout': return 'Windows MIDI 端口枚举未响应。请恢复系统 MIDI 服务后点击“重新检测”。依赖 MIDI 的播放暂不可用，工程仍可编辑。';
    case 'failed': return 'MIDI 检测组件运行失败。请查看诊断日志并修复检测组件，随后点击“重新检测”。工程仍可编辑。';
  }
}

export function midiProbeExecutable(resourcesPath?: string): string {
  return resourcesPath ? join(resourcesPath, 'midi', 'tblink-midi-probe.exe') : resolve(__dirname, '../../../../tools/midi-probe/bin/tblink-midi-probe.exe');
}

/** Share one probe, retain failures until the operator explicitly checks again. */
export class WindowsMidiHealth {
  private pending: Promise<MidiHealth> | null = null;
  private result: MidiHealth | null = null;
  constructor(private readonly probe: () => Promise<MidiHealth>) {}

  check(recheck = false): Promise<MidiHealth> {
    if (this.pending) return this.pending;
    // A successful startup probe is not a lifetime guarantee: Windows can
    // begin stopping the service while this desktop session remains open.
    // Recheck at each new MIDI access, but never retry a known failure without
    // the operator's explicit action. Concurrent access still shares a probe.
    if (this.result !== null && this.result !== 'ready' && !recheck) return Promise.resolve(this.result);
    const request = this.probe().then((result) => {
      this.result = result;
      return result;
    }).finally(() => { this.pending = null; });
    this.pending = request;
    return request;
  }
}

export function probeWindowsMidi(executable: string): Promise<MidiHealth> {
  return new Promise((resolveProbe) => {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    let settled = false;
    const complete = (result: MidiHealth): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe(result);
    };
    // A missing/broken executable must not hold the UI even if no exit arrives.
    // The native helper self-exits; do not kill an unresponsive external process.
    const timer = setTimeout(() => {
      child.stdout.destroy();
      child.unref();
      complete('timeout');
    }, 2500);
    child.stdout.on('data', (data: Buffer) => { output = (output + data.toString('utf8')).slice(-64); });
    child.stdout.on('error', () => complete('failed'));
    child.on('error', () => complete('failed'));
    child.on('close', (code) => {
      const parsed = resultSchema.safeParse(output.trim());
      complete(parsed.success && (parsed.data !== 'ready' || code === 0) ? parsed.data : 'failed');
    });
  });
}
