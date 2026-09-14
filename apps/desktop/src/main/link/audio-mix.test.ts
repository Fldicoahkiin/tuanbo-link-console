import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AudioEditService } from './audio-edit-service';
import { LinkProjectService } from './link-project-service';

function stereoWav(left: number, right: number): Buffer {
  const pcm = Buffer.alloc(48000 * 4 * 0.3);
  for (let index = 0; index < pcm.length; index += 4) { pcm.writeInt16LE(left, index); pcm.writeInt16LE(right, index + 2); }
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(48000, 24); header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function cleanOwnedFixture(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await cleanOwnedFixture(path); else await unlink(path);
  }
  await rmdir(directory);
}

it('真实 FFmpeg 混合两条独立音轨，保留声道、增益、素材入点和时间线间隙', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-mix-'));
  try {
    const sources = await Promise.all([[1000, 0], [0, 2000]].map(async (levels, index) => {
      const buffer = stereoWav(levels[0]!, levels[1]!);
      const name = `source-${index}.wav`; await writeFile(join(directory, name), buffer);
      return { assetId: name, relativePath: name, durationMs: 300, sha256: createHash('sha256').update(buffer).digest('hex') };
    }));
    const service = new AudioEditService(new LinkProjectService());
    const tracks = sources.map((source, index) => ({ id: `track-${index}`, title: source.assetId, source, segments: [{ id: `clip-${index}`, startMs: index * 100, sourceOffsetMs: index * 50, durationMs: index ? 100 : 300 }] }));
    const result = await service.mix(join(directory, 'show.tblink'), tracks);
    const wav = await readFile(join(directory, result.relativePath));
    const offset = wav.indexOf(Buffer.from('data')) + 8;
    const sample = (ms: number, channel: number): number => wav.readInt16LE(offset + ms * 192 + channel * 2);
    expect(result.durationMs).toBe(300);
    expect(result.timeline?.tracks).toEqual(tracks);
    expect(sample(50, 0)).toBeCloseTo(1000, 0);
    expect(sample(50, 1)).toBe(0);
    expect(sample(150, 0)).toBeCloseTo(1000, 0);
    expect(sample(150, 1)).toBeCloseTo(2000, 0);
    expect(sample(250, 1)).toBe(0);
    expect(await readdir(join(directory, 'cache', 'audio-edit'))).toEqual([]);
  } finally { await cleanOwnedFixture(directory); }
}, 30000);
