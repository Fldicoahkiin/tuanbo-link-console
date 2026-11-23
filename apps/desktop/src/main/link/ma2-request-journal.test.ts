import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Ma2RequestJournal } from './ma2-request-journal';

it('重启后只恢复本端登记的请求，释放一个不丢另一个', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ma2-request-journal-'));
  try {
    const path = join(folder, 'requests.json');
    // Ownerless records can belong to a live older version using the same profile.
    const old = 'c'.repeat(32), other = 'd'.repeat(32);
    await mkdir(join(path + '.pending', old), { recursive: true });
    await writeFile(path, JSON.stringify([old, other]));
    const first = new Ma2RequestJournal(path);
    expect(first.pending()).toEqual([]); // Neither older format identifies a dead owner.
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify([old, other]));
    first.begin('a'.repeat(32)); first.begin('b'.repeat(32));
    const restarted = new Ma2RequestJournal(path);
    expect(restarted.pending()).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
    restarted.released('a'.repeat(32));
    first.begin(other); // An older instance must preserve a newer instance's changes.
    expect(new Ma2RequestJournal(path).pending().sort()).toEqual(['b'.repeat(32), other]);
    restarted.released(other);
    expect(() => first.begin('../elsewhere')).toThrow();
    expect(new Ma2RequestJournal(join(folder, 'other-console.json')).pending()).toEqual([]);
    restarted.released('b'.repeat(32));
    expect(new Ma2RequestJournal(path).pending()).toEqual([]);
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const ended = once(child, 'exit');
    try {
      await once(child, 'spawn');
      await mkdir(join(path + '.pending', other + '.' + child.pid));
      expect(restarted.pending()).toEqual([]);
      restarted.released(other); // A different active owner keeps its marker.
    } finally { child.stdin.end(); await ended; }
    expect(restarted.pending()).toEqual([other]);
    restarted.released(other); expect(first.pending()).toEqual([]);
    // A damaged or partially updated older journal must not prevent the new
    // client from using its own lane, or lend it authority to release a lease.
    await writeFile(path, '["partial');
    await writeFile(join(path + '.pending', other + '.' + process.pid), 'foreign file');
    await mkdir(join(path + '.pending', other + '.9999999999'));
    const recovered = new Ma2RequestJournal(path);
    recovered.begin(old);
    expect(recovered.pending()).toEqual([old]);
    recovered.released(old);
    expect(await readFile(path, 'utf8')).toBe('["partial');
    expect(await readFile(join(path + '.pending', other + '.' + process.pid), 'utf8')).toBe('foreign file');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
