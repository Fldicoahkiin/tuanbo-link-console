import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Ma2RequestJournal } from './ma2-request-journal';

it('重启后只恢复本端登记的请求，释放一个不丢另一个', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ma2-request-journal-'));
  try {
    const path = join(folder, 'requests.json');
    const first = new Ma2RequestJournal(path);
    first.begin('a'.repeat(32)); first.begin('b'.repeat(32));
    const restarted = new Ma2RequestJournal(path);
    expect(restarted.pending()).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    restarted.released('a'.repeat(32));
    expect(new Ma2RequestJournal(path).pending()).toEqual(['b'.repeat(32)]);
    expect(new Ma2RequestJournal(join(folder, 'other-console.json')).pending()).toEqual([]);
    restarted.released('b'.repeat(32));
    expect(new Ma2RequestJournal(path).pending()).toEqual([]);
    await writeFile(path, '["not-an-id"]');
    expect(() => new Ma2RequestJournal(path)).toThrow();
  } finally { await rm(folder, { recursive: true, force: true }); }
});
