import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const resultSchema = z.enum(['ready', 'timeout', 'stopping', 'failed']);
export type MidiHealth = z.infer<typeof resultSchema>;
export function midiHealthMessage(result: MidiHealth): string {
  switch (result) {
    case 'ready': return 'MIDI 系统检测通过';
    case 'stopping': return 'Windows MIDI 服务正在停止，MIDI 连接还没释放。请正常退出用到 MIDI 的软件，等服务恢复后点“重新检测”；如果一直停不下来，请保存工作后重启电脑。工程可以照常编辑。';
    case 'timeout': return 'Windows 读取 MIDI 端口没有响应。请恢复系统 MIDI 服务后点“重新检测”。在这之前需要 MIDI 的播放用不了，工程可以照常编辑。';
    case 'failed': return 'MIDI 检测组件运行失败。请重新安装联动台后点“重新检测”；仍然失败请导出诊断包发给售后。工程可以照常编辑。';
  }
}

export function midiProbeExecutable(resourcesPath?: string): string {
  return resourcesPath ? join(resourcesPath, 'midi', 'tblink-midi-probe.exe') : resolve(__dirname, '../../../../tools/midi-probe/bin/tblink-midi-probe.exe');
}

/** Share one probe, retain failures until the operator explicitly checks again
 * (or the timecode port recovery does, while it waits for a lost port). */
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
