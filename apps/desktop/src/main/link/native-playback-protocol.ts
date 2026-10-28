import { nativePlaybackCommandSchema, nativePlaybackEventSchema, type NativePlaybackCommand, type NativePlaybackEvent } from '@tb/schema';
import { toNamespacedPath } from 'node:path';

const operations: Record<NativePlaybackCommand['kind'], number> = { prepare: 1, play: 2, pause: 3, seek: 4, stop: 5, volume: 6, close: 7, 'stop-mtc': 8, 'reopen-mtc': 9 };
/** Fixed little-endian header. The helper validates the same header before using it. */
export function encodeNativePlaybackCommand(input: NativePlaybackCommand): Buffer {
  const command = nativePlaybackCommandSchema.parse(input);
  const path = command.kind === 'prepare' ? Buffer.from(toNamespacedPath(command.pcmPath), 'utf8') : Buffer.alloc(0);
  const device = command.kind === 'prepare' ? Buffer.from(command.audioDeviceId ?? 'default', 'utf8')
    : command.kind === 'reopen-mtc' ? Buffer.from(command.midiPortName, 'utf8') : Buffer.alloc(0);
  const port = command.kind === 'prepare' && command.midiPortName ? Buffer.from(command.midiPortName, 'utf8') : Buffer.alloc(0);
  if (path.length > 8192) throw new Error('音频缓存路径过长');
  if (device.length > 2048) throw new Error('音频设备标识过长');
  const bytes = Buffer.alloc(96 + path.length + device.length + port.length);
  bytes.writeUInt32LE(0x34504254, 0); bytes.writeUInt32LE(bytes.length, 4);
  bytes.writeUInt32LE(command.requestId, 8); bytes.writeUInt32LE(command.generation, 12);
  bytes.writeUInt32LE(operations[command.kind], 16);
  if (command.kind === 'prepare') {
    bytes.writeUInt32LE(command.sampleRate, 20); bytes.writeUInt32LE(command.midiDevice ?? 0xffffffff, 24);
    // 2997 asks the engine for 29.97 drop-frame labels.
    bytes.writeUInt32LE(command.frameRate === 29.97 ? 2997 : command.frameRate, 28);
    bytes.writeDoubleLE(command.startMs, 32); bytes.writeDoubleLE(command.endMs, 40);
    bytes.writeDoubleLE(command.offsetMs, 48); bytes.writeDoubleLE(command.volume, 56);
    bytes.writeUInt32LE(path.length, 72); path.copy(bytes, 96);
    bytes.writeUInt32LE(device.length, 76); device.copy(bytes, 96 + path.length);
    bytes.writeDoubleLE(command.pcmBaseMs ?? 0, 80);
    bytes.writeUInt32LE((command.streaming ? 1 : 0) | (command.quarterFramesOnly ? 2 : 0), 88);
    bytes.writeUInt32LE(port.length, 92); port.copy(bytes, 96 + path.length + device.length);
  }
  if (command.kind === 'reopen-mtc') { bytes.writeUInt32LE(command.midiDevice, 24); bytes.writeUInt32LE(device.length, 76); device.copy(bytes, 96); }
  if (command.kind === 'seek') bytes.writeDoubleLE(command.positionMs, 32);
  if (command.kind === 'volume') { bytes.writeDoubleLE(command.volume, 56); bytes.writeDoubleLE(command.durationMs ?? 0, 64); }
  return bytes;
}

/** Limit an individual message, not a valid batch delivered after a busy host
 * thread. Native output continues even if telemetry is read less frequently. */
export class NativePlaybackEventDecoder {
  private buffer = '';
  push(data: string): NativePlaybackEvent[] {
    const events: NativePlaybackEvent[] = [];
    const lines = data.split('\n');
    for (let index = 0; index < lines.length; index++) {
      this.buffer += lines[index]!;
      if (this.buffer.length > 65536) throw new Error('播放引擎单条响应超过容量');
      if (index + 1 < lines.length) {
        events.push(nativePlaybackEventSchema.parse(JSON.parse(this.buffer)));
        this.buffer = '';
      }
    }
    return events;
  }
}
