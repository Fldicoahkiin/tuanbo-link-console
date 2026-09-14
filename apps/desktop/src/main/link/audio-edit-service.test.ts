import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { composeAudioPcm } from './audio-edit-service';

it('音频编辑按源位置复制采样，并在时间线空隙写入静音', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-pcm-'));
  const source = join(directory, 'source.pcm'); const output = join(directory, 'edit.pcm');
  const pcm = Buffer.concat([Buffer.alloc(192, 1), Buffer.alloc(192, 2), Buffer.alloc(192, 3)]);
  await writeFile(source, pcm);
  try {
    await composeAudioPcm(source, output, [
      { id: 'a', startMs: 0, sourceOffsetMs: 2, durationMs: 1 },
      { id: 'b', startMs: 2, sourceOffsetMs: 0, durationMs: 1 }
    ]);
    expect(await readFile(output)).toEqual(Buffer.concat([Buffer.alloc(192, 3), Buffer.alloc(192), Buffer.alloc(192, 1)]));
  } finally { await unlink(source); await unlink(output); await rmdir(directory); }
});
