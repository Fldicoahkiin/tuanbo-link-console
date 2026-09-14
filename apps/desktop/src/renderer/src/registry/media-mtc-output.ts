import { encodeMediaTimecode, playbackFramesPerSecond } from '@tb/core/link';
import type { MtcFrameRate } from '@tb/schema';

export class MediaMtcOutput {
  private output: MIDIOutput | null = null;
  private nextQuarterFrame = 0;
  private lastTickAt: number | null = null;
  private rate: MtcFrameRate | null = null;
  private piece = 0;
  private messages: number[][] = [];
  private locate = true;

  async connect(portName: string | null): Promise<void> {
    this.stop(); this.output = null;
    if (!portName) return;
    const access = await navigator.requestMIDIAccess({ sysex: true });
    const ports = [...access.outputs.values()].filter((port) => port.name === portName && port.state === 'connected');
    if (ports.length !== 1) throw new Error(`MIDI 时间码输出不可用或不唯一：${portName}`);
    const port = ports[0];
    if (!port) throw new Error('MIDI 输出不存在');
    await port.open(); this.output = port;
  }

  tick(positionMs: number, rate: MtcFrameRate, now = performance.now()): void {
    if (!this.output) return;
    if (!Number.isFinite(positionMs) || positionMs < 0 || positionMs >= 86400000) throw new Error('MIDI 时间码音频位置无效');
    if (!Number.isFinite(now) || now < 0) throw new Error('MIDI 时间码调度时钟无效');
    if (this.output.state !== 'connected') throw new Error('灯光 MIDI 输出已断开，内部主控已停止');
    if (this.rate !== rate) { this.stop(); this.rate = rate; }
    if (this.lastTickAt !== null && now - this.lastTickAt > 100) throw new Error('MIDI 时间码发送延迟超过 100ms，已停止播放');
    this.lastTickAt = now;
    const fps = playbackFramesPerSecond(rate);
    const frameMs = 1000 / fps;
    if (this.locate) {
      this.output.send(encodeMediaTimecode(positionMs, rate).fullFrame);
      this.locate = false;
      // Locate immediately, but begin quarter frames on an actual media frame boundary.
      this.nextQuarterFrame = Math.ceil(positionMs / 1000 * fps) * 4;
    }
    if (positionMs - this.nextQuarterFrame * 1000 / (fps * 4) > 100) throw new Error('MIDI 时间码发送延迟超过 100ms，已停止播放');
    while (this.nextQuarterFrame <= positionMs / 1000 * fps * 4) {
      if (this.piece === 0) {
        const frame = this.nextQuarterFrame / 4;
        // Encode inside the selected frame to avoid floating point rounding to its predecessor.
        this.messages = encodeMediaTimecode((frame + 0.5) * frameMs, rate).quarterFrames;
      }
      const message = this.messages[this.piece];
      if (!message) throw new Error('MIDI 时间码消息不完整');
      // Send only messages already due: Electron has no MIDIOutput.clear(), so
      // future timestamped messages cannot be cancelled reliably at pause/seek.
      this.output.send(message);
      this.piece = (this.piece + 1) % 8; this.nextQuarterFrame += 1;
    }
  }

  stop(): void {
    this.nextQuarterFrame = 0; this.lastTickAt = null; this.rate = null; this.piece = 0; this.messages = []; this.locate = true;
  }
}
