import { open, type FileHandle } from 'node:fs/promises';
import type { AudioSegment } from '@tb/schema';

type PcmTrack = { path: string; offset: number; bytes: number; segments: readonly AudioSegment[] };
const BYTES_PER_MS = 192;
const BLOCK_BYTES = 512 * 1024;

/** Bounded sample mixing for decoded sources. Each block yields through file I/O;
 * no whole-song buffers or unbounded sample loops occupy the Electron thread.
 * Above the existing limiter threshold, the caller uses the unchanged FFmpeg
 * limiter instead of clipping, normalizing or changing the mix's sound. */
export async function mixPcmTracks(tracks: readonly PcmTrack[], outputPath: string, durationMs: number): Promise<'complete' | 'limiter-required'> {
  const sources: FileHandle[] = [];
  let output: FileHandle | undefined;
  try {
    for (const track of tracks) {
      for (const segment of track.segments) {
        if ((segment.sourceOffsetMs + segment.durationMs) * BYTES_PER_MS > track.bytes + BYTES_PER_MS) throw new Error('音频片段范围超出已解码音频');
      }
      sources.push(await open(track.path, 'r'));
    }
    output = await open(outputPath, 'wx');
    await output.writeFile(pcmWaveHeader(durationMs));
    const input = Buffer.alloc(BLOCK_BYTES);
    const encoded = Buffer.alloc(BLOCK_BYTES);
    // The deployed Windows x64 audio format and typed arrays are little-endian.
    const inputSamples = new Int16Array(input.buffer, input.byteOffset, BLOCK_BYTES / 2);
    const outputSamples = new Int16Array(encoded.buffer, encoded.byteOffset, BLOCK_BYTES / 2);
    const sums = new Int32Array(BLOCK_BYTES / 2);
    const ordered = tracks.map(track => [...track.segments].sort((a, b) => a.startMs - b.startMs));
    const cursors = tracks.map(() => 0);
    const bytes = durationMs * BYTES_PER_MS;
    for (let position = 0; position < bytes; position += BLOCK_BYTES) {
      const length = Math.min(BLOCK_BYTES, bytes - position);
      sums.fill(0);
      for (const [index, track] of tracks.entries()) {
        const segments = ordered[index]!;
        let cursor = cursors[index]!;
        while (cursor < segments.length && (segments[cursor]!.startMs + segments[cursor]!.durationMs) * BYTES_PER_MS <= position) cursor++;
        cursors[index] = cursor;
        for (let current = cursor; current < segments.length; current++) {
          const segment = segments[current]!;
          const begin = segment.startMs * BYTES_PER_MS;
          if (begin >= position + length) break;
          const left = Math.max(position, begin);
          const right = Math.min(position + length, begin + segment.durationMs * BYTES_PER_MS);
          const sourcePosition = segment.sourceOffsetMs * BYTES_PER_MS + left - begin;
          const count = right - left;
          input.fill(0, 0, count);
          // Only the existing sub-millisecond decoded tail tolerance is padded.
          const available = Math.min(count, Math.max(0, track.bytes - sourcePosition));
          let read = 0;
          while (read < available) {
            const result = await sources[index]!.read(input, read, available - read, track.offset + sourcePosition + read);
            if (!result.bytesRead) throw new Error('音频源数据提前结束');
            read += result.bytesRead;
          }
          const destination = (left - position) / 2;
          for (let sample = 0; sample < count / 2; sample++) sums[destination + sample]! += inputSamples[sample]!;
        }
      }
      for (let sample = 0; sample < length / 2; sample++) {
        const value = sums[sample]!;
        if (Math.abs(value) > 0.98 * 32768) return 'limiter-required';
        outputSamples[sample] = value;
      }
      await output.writeFile(encoded.subarray(0, length));
    }
    return 'complete';
  } finally {
    const closed = await Promise.allSettled([...sources, ...output ? [output] : []].map(file => file.close()));
    const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason as unknown);
    if (failures.length) throw new AggregateError(failures, '音轨文件关闭失败');
  }
}

export function pcmWaveHeader(durationMs: number): Buffer {
  const bytes = durationMs * BYTES_PER_MS;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes + 36 > 0xffffffff) throw new Error('音频时长超出 PCM WAV 范围');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
  return header;
}
