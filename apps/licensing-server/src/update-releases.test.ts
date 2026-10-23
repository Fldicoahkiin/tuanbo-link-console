import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UpdateReleases } from './update-releases';

function spool(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tblink-update-spool-'));
  for (const name of ['update-requests', 'update-results']) mkdirSync(join(directory, name));
  return directory;
}

it('queues a request under a name the path unit ignores until it is complete, then reads the outcome', async () => {
  const directory = spool();
  const releases = new UpdateReleases(directory, 2000, 20);
  const id = '9d53530a-6712-423e-985e-e69beb9ec1c6';
  const pending = releases.request({ id, action: 'publish', staged: '0.5.0-13f7e625898e', manifestSha256: 'a'.repeat(64), actor: 'owner', reason: '发布' });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(readdirSync(join(directory, 'update-requests'))).toEqual([`${id}.json`]);
  expect(JSON.parse(readFileSync(join(directory, 'update-requests', `${id}.json`), 'utf8'))).toMatchObject({ id, action: 'publish' });
  writeFileSync(join(directory, 'update-results', `${id}.json`), JSON.stringify({ id, ok: false, message: 'Release signature invalid', at: '2026-10-23T08:00:00Z' }));
  await expect(pending).resolves.toEqual({ ok: false, message: 'Release signature invalid' });
});

it('reports no answer as null and a missing status as unavailable', async () => {
  const directory = spool();
  const releases = new UpdateReleases(directory, 100, 20);
  await expect(releases.request({ id: '9d53530a-6712-423e-985e-e69beb9ec1c7', action: 'rollback', version: '0.4.29', actor: 'owner', reason: '回退' })).resolves.toBeNull();
  await expect(releases.status()).rejects.toThrow('发布助手尚未生成状态');
  writeFileSync(join(directory, 'update-status.json'), JSON.stringify({ version: 1, generatedAt: 'now', feed: null, rollback: { version: null, issue: '没有可以回滚到的上一版' }, staged: [] }));
  await expect(releases.status()).resolves.toMatchObject({ feed: null, staged: [] });
});
