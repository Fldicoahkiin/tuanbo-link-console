import { open } from 'node:fs/promises';

/** Reject silence before IBT (which otherwise extrapolates a grid even on silence). */
export async function hasAudiblePcm(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    await file.read(header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8) !== 'WAVE') throw new Error('节拍分析需要 PCM WAV');
    const bytes = (await file.stat()).size;
    let offset = 12, validFormat = false;
    const chunkHeader = Buffer.alloc(8);
    const block = Buffer.alloc(65536);
    while (offset + 8 <= bytes) {
      await file.read(chunkHeader, 0, 8, offset);
      const kind = chunkHeader.toString('ascii', 0, 4), size = chunkHeader.readUInt32LE(4);
      offset += 8;
      if (offset + size > bytes) throw new Error('节拍分析音频数据不完整');
      if (kind === 'fmt ') {
        if (size < 16) throw new Error('节拍分析音频格式不完整');
        await file.read(block, 0, 16, offset);
        validFormat = block.readUInt16LE(0) === 1 && block.readUInt16LE(2) === 1 && block.readUInt16LE(14) === 16;
      }
      if (kind === 'data') {
        if (!validFormat || size % 2) throw new Error('节拍分析需要单声道 16 位 PCM');
        for (let position = offset; position < offset + size;) {
          const count = Math.min(block.length, offset + size - position);
          const { bytesRead } = await file.read(block, 0, count, position);
          if (bytesRead !== count) throw new Error('节拍分析音频数据提前结束');
          for (let index = 0; index < count; index += 2) if (Math.abs(block.readInt16LE(index)) > 3) return true;
          position += count;
        }
        return false;
      }
      offset += size + size % 2;
    }
    throw new Error('节拍分析音频缺少采样数据');
  } finally { await file.close(); }
}
