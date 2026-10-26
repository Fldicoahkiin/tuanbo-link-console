import { requestMidiAccess, type MidiAccess, type MidiOutput } from './midi-access';
import { requireOutputLicense } from './license-output';
import { encodeMediaTimecode, playbackFramesPerSecond } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';

export class MediaMtcOutput {
  private access: MidiAccess | null = null;
  private output: MidiOutput | null = null;
  private nextQuarterFrame = 0;
  private lastTickAt: number | null = null;
  private lastPositionMs: number | null = null;
  private rate: MtcFrameRate | null = null;
  private piece = 0;
  private messages: number[][] = [];
  private locate = true;
  private connectionAttempt: AbortController | null = null;
  private schedulingNotice: string | null = null;
  private interruptions = 0;

  takeSchedulingNotice(): string | null {
    const notice = this.schedulingNotice; this.schedulingNotice = null; return notice;
  }

  async connect(portName: string | null, autoDetect = false): Promise<string | null> {
    this.stop();
    const previous = this.output; this.output = null;
    if (!portName && !autoDetect) { this.release(previous); return null; }
    const attempt = new AbortController();
    this.connectionAttempt = attempt;
    try {
      await requireOutputLicense();
      if (attempt.signal.aborted) throw new Error('MIDI 连接已取消');
      const access = this.access ??= await waitForMidi(requestMidiAccess(), attempt.signal, '读取 MIDI 接口');
      const available = [...access.outputs.values()].filter(port => port.state === 'connected' && port.name && !/Microsoft GS Wavetable Synth/i.test(port.name));
      if (!portName) {
        if (available.length !== 1) throw new Error(available.length === 0
          ? '没有找到 MIDI 输出。请接好 USB-MIDI 接口并检查驱动，再点播放。'
          : `电脑上有 ${available.length} 个 MIDI 输出（${available.map(port => port.name).join('、')}），不知道哪个接着控台。请到 设置 → 音频与 MIDI 选好“时间码输出”。`);
        portName = available[0]!.name;
      }
      const ports = [...access.outputs.values()].filter((port) => port.name === portName && port.state === 'connected');
      if (ports.length === 0) throw new Error(`没有找到 MIDI 时间码输出「${portName}」。请检查 USB 线和驱动，再到 设置 → 音频与 MIDI 刷新；虚拟端口请保持 loopMIDI 运行。`);
      if (ports.length > 1) throw new Error(`电脑上有 ${ports.length} 个叫「${portName}」的 MIDI 输出，分不清用哪个。请拔掉多余的一个，再重新播放。`);
      const port = ports[0];
      if (!port) throw new Error('MIDI 输出不存在');
      // The earlier port is let go only now: the same port keeps its connection.
      if (previous !== port) this.release(previous);
      await waitForMidi(port.open(), attempt.signal, `打开 MIDI 输出「${portName}」`);
      if (attempt.signal.aborted) throw new Error('MIDI 连接已取消');
      this.output = port;
      return port.name;
    } catch (error) {
      this.release(previous);
      throw error;
    } finally {
      if (this.connectionAttempt === attempt) this.connectionAttempt = null;
    }
  }

  /** Ends timecode and lets the port go, so P1 or formal playback can open it. */
  close(): void {
    this.stop();
    const output = this.output; this.output = null;
    this.release(output);
  }

  tick(positionMs: number, rate: MtcFrameRate, now = performance.now()): boolean {
    if (!this.output) return false;
    let sent = false;
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= 86400000) throw new Error('MIDI 时间码音频位置无效');
    if (!Number.isFinite(now) || now < 0) throw new Error('MIDI 时间码调度时钟无效');
    if (this.output.state !== 'connected') throw new Error(`MIDI 接口「${this.output.name}」断开了，时间码已停止。插好后重新播放。`);
    // A port closed by itself (taken by formal playback, failed) is not reopened here: the operator plays again.
    if (this.output.connection !== 'open') throw new Error(this.output.closedReason ?? `MIDI 接口「${this.output.name}」已关闭，时间码已停止。请检查接口后重新播放。`);
    if (this.rate !== rate) { this.reset(); this.rate = rate; }
    const elapsed = this.lastTickAt === null ? 0 : now - this.lastTickAt;
    const advanced = this.lastPositionMs === null ? 0 : positionMs - this.lastPositionMs;
    if (elapsed < 0) throw new Error('MIDI 时间码调度时钟回跳，时间码输出已停止');
    this.lastTickAt = now;
    this.lastPositionMs = positionMs;
    const fps = playbackFramesPerSecond(rate);
    const frameMs = 1000 / fps;
    // A stalled renderer or a jumping audio position never bursts expired
    // quarters into the console. The stream relocates with a Full Frame at
    // the actual audio position and continues; the interruption is reported.
    const interruption = advanced < 0 ? '音频位置回跳'
      : elapsed > 500 ? `调度中断 ${Math.round(elapsed)}ms`
        : Math.abs(advanced - elapsed) > 100 ? '音频位置与播放时钟不一致'
          : !this.locate && positionMs - this.nextQuarterFrame * frameMs / 4 > frameMs ? `调度滞后超过一帧（${Math.round(frameMs)}ms）` : null;
    if (interruption) {
      this.locate = true; this.piece = 0; this.messages = [];
      this.schedulingNotice = `时间码中断 ${++this.interruptions} 次（${interruption}）：迟到部分未补发，已按音频位置整帧重新同步，控台会跳到当前位置`;
    }
    if (this.locate) {
      this.output.send(encodeMediaTimecode(positionMs, rate).fullFrame);
      sent = true;
      this.locate = false;
      // Locate immediately, but begin quarter frames on an actual media frame boundary.
      this.nextQuarterFrame = Math.ceil(positionMs / 1000 * fps) * 4;
    }
    while (this.nextQuarterFrame <= positionMs / 1000 * fps * 4) {
      if (this.piece === 0) {
        const frame = this.nextQuarterFrame / 4;
        // Encode inside the selected frame to avoid floating point rounding to its predecessor.
        this.messages = encodeMediaTimecode((frame + 0.5) * frameMs, rate).quarterFrames;
      }
      const message = this.messages[this.piece];
      if (!message) throw new Error('MIDI 时间码消息不完整');
      // Send only messages already due: a queued message cannot be taken back at pause/seek.
      this.output.send(message);
      sent = true;
      this.piece = (this.piece + 1) % 8; this.nextQuarterFrame += 1;
    }
    return sent;
  }

  stop(): void {
    this.connectionAttempt?.abort(); this.connectionAttempt = null;
    this.reset(); this.schedulingNotice = null; this.interruptions = 0;
  }
  private release(port: MidiOutput | null): void {
    if (port && port !== this.output) void port.close().catch((error: unknown) => console.error(`MIDI 接口「${port.name}」关闭失败`, error));
  }
  private reset(): void {
    this.nextQuarterFrame = 0; this.lastTickAt = null; this.lastPositionMs = null; this.rate = null; this.piece = 0; this.messages = []; this.locate = true;
  }
}

function waitForMidi<T>(operation: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); complete();
    };
    const cancel = (): void => finish(() => reject(new Error('MIDI 连接已取消')));
    const timer = setTimeout(() => finish(() => reject(new Error(`${label}超时（5 秒），请检查设备后手动重试`))), 5000);
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error instanceof Error ? error : new Error(String(error)))));
    if (signal.aborted) cancel();
  });
}
