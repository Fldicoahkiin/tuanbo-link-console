import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UpdateReleases } from './update-releases';

function directories(): { requests: string; publisher: string } {
  const directory = mkdtempSync(join(tmpdir(), 'tblink-update-'));
  for (const name of ['update-requests', 'publisher/results']) mkdirSync(join(directory, name), { recursive: true });
  return { requests: join(directory, 'update-requests'), publisher: join(directory, 'publisher') };
}

it('queues a request under a name the path unit ignores until it is complete, then reads the outcome', async () => {
  const { requests, publisher } = directories();
  const releases = new UpdateReleases(requests, publisher, 2000, 20);
  const id = '9d53530a-6712-423e-985e-e69beb9ec1c6';
  // An earlier request that already has an answer is cleaned up before the new one is written.
  writeFileSync(join(requests, '9d53530a-6712-423e-985e-e69beb9ec1c0.json'), '{}');
  writeFileSync(join(publisher, 'results', '9d53530a-6712-423e-985e-e69beb9ec1c0.json'), '{}');
  const pending = releases.request({ id, action: 'publish', staged: '0.5.0-13f7e625898e', manifestSha256: 'a'.repeat(64), actor: 'owner', reason: '发布', requestedAt: '2026-10-23T08:00:00.000Z' });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(readdirSync(requests)).toEqual([`${id}.json`]);
  expect(JSON.parse(readFileSync(join(requests, `${id}.json`), 'utf8'))).toMatchObject({ id, action: 'publish' });
  writeFileSync(join(publisher, 'results', `${id}.json`), JSON.stringify({ id, ok: false, message: 'Release signature invalid', at: '2026-10-23T08:00:00Z' }));
  await expect(pending).resolves.toEqual({ ok: false, message: 'Release signature invalid' });
  expect(readdirSync(requests)).toEqual([]);
});

it('reports no answer as null and a missing status as unavailable', async () => {
  const { requests, publisher } = directories();
  const releases = new UpdateReleases(requests, publisher, 100, 20);
  await expect(releases.request({ id: '9d53530a-6712-423e-985e-e69beb9ec1c7', action: 'rollback', version: '0.4.29', actor: 'owner', reason: '回退', requestedAt: '2026-10-23T08:00:00.000Z' })).resolves.toBeNull();
  await expect(releases.status()).rejects.toThrow('发布助手尚未生成状态');
  writeFileSync(join(publisher, 'update-status.json'), JSON.stringify({ version: 1, generatedAt: 'now', feed: null, rollback: { version: null, issue: '没有可以回滚到的上一版' }, staged: [] }));
  await expect(releases.status()).resolves.toMatchObject({ feed: null, staged: [] });
});
