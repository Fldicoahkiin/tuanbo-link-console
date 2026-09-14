import { writeMidi, type MidiEvent } from 'midi-file';

/** Bound midi-file's array-copy cost while retaining its event encoders. */
export function writeLightingMidi(tracks: MidiEvent[][], ticksPerBeat: number): Uint8Array {
  if (!Number.isInteger(ticksPerBeat) || ticksPerBeat < 1 || ticksPerBeat > 32767) throw new Error('MIDI 节拍精度无效');
  if (tracks.length > 65535) throw new Error('MIDI 轨道数量超限');
  const parts: Uint8Array[] = [];
  const header = Uint8Array.from(writeMidi({ header: { format: 1, numTracks: 0, ticksPerBeat }, tracks: [] }));
  new DataView(header.buffer).setUint16(10, tracks.length);
  parts.push(header);
  let size = header.length;
  for (const track of tracks) {
    if (track.some((event) => !Number.isInteger(event.deltaTime) || event.deltaTime < 0 || event.deltaTime > 0x0fffffff)) throw new Error('MIDI 事件间隔超出标准文件范围');
    const chunks: Uint8Array[] = [];
    let trackSize = 0;
    for (let offset = 0; offset < track.length; offset += 256) {
      const encoded = writeMidi({ header: { format: 1, numTracks: 1, ticksPerBeat }, tracks: [track.slice(offset, offset + 256)] }, { running: false });
      // A generated SMF header is 14 bytes; its first MTrk header is 8 bytes.
      const chunk = Uint8Array.from(encoded.slice(22));
      chunks.push(chunk); trackSize += chunk.length;
      if (size + 8 + trackSize > 32 * 1024 * 1024) throw new Error('MIDI 文件超过 32 MB，请减少事件或拆分节目');
    }
    const trackHeader = new Uint8Array([77, 84, 114, 107, 0, 0, 0, 0]);
    new DataView(trackHeader.buffer).setUint32(4, trackSize);
    parts.push(trackHeader, ...chunks); size += 8 + trackSize;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
