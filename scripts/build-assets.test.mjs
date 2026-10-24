import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetTag, checkDescriptor, splitFile } from './build-assets.mjs';

test('分卷按上限切开，拼回去与原文件逐字节相同，每卷带自己的 sha256', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'build-assets-'));
  const archive = join(directory, 'music-analysis.tar.gz');
  const bytes = randomBytes(2500);
  await writeFile(archive, bytes);
  const parts = await splitFile(archive, 1000);
  assert.deepEqual(parts.map(part => [part.name, part.size]), [['music-analysis.tar.gz.001', 1000], ['music-analysis.tar.gz.002', 1000], ['music-analysis.tar.gz.003', 500]]);
  const joined = Buffer.concat(await Promise.all(parts.map(part => readFile(join(directory, part.name)))));
  assert.ok(joined.equals(bytes));
  for (const part of parts) assert.equal(part.sha256, createHash('sha256').update(await readFile(join(directory, part.name))).digest('hex'));
});

test('build-assets.json 必须与仓库里的指纹一致', () => {
  const pin = 'a'.repeat(64);
  const parts = [{ name: 'beauty.tar.gz.001', size: 1, sha256: 'b'.repeat(64) }];
  assert.equal(assetTag('beauty', pin), 'build-assets-beauty-aaaaaaaaaaaa');
  assert.deepEqual(checkDescriptor({ version: 1, kind: 'beauty', pin, parts }, 'beauty', pin), parts);
  for (const descriptor of [{ version: 1, kind: 'beauty', pin: 'c'.repeat(64), parts }, { version: 1, kind: 'music-analysis', pin, parts }, { version: 1, kind: 'beauty', pin, parts: [] }, null]) {
    assert.throws(() => checkDescriptor(descriptor, 'beauty', pin), /不一致/);
  }
});
