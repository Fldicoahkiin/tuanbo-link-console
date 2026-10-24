import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { releaseOf, uploadAsset } from './github-releases.mjs';

test('按标签找 release：草稿和正式都算，同一标签有两个就报错', () => {
  const draft = { id: 1, tag_name: 'v0.5.1', draft: true };
  const other = { id: 2, tag_name: 'v0.5.0', draft: false };
  assert.equal(releaseOf([other, draft], 'v0.5.1'), draft);
  assert.equal(releaseOf([other], 'v0.5.1'), null);
  assert.throws(() => releaseOf([draft, { id: 3, tag_name: 'v0.5.1', draft: false }], 'v0.5.1'), /2 个 release/);
});

test('附件从文件分块流式上传，并声明 Content-Length', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'upload-asset-')), 'installer.exe');
  const bytes = randomBytes(5 * 1024 * 1024 + 123);
  await writeFile(file, bytes);
  const received = { chunks: 0, data: [], headers: null, url: null };
  const server = createServer((request, response) => {
    received.headers = request.headers; received.url = request.url;
    request.on('data', chunk => { received.chunks += 1; received.data.push(chunk); });
    request.on('end', () => { response.writeHead(201, { 'content-type': 'application/json' }); response.end('{}'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  try {
    const size = await uploadAsset({ id: 42 }, 'Tuanbo Link.exe', file, `http://127.0.0.1:${server.address().port}`);
    assert.equal(size, bytes.length);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved;
    server.close();
  }
  assert.equal(received.url, '/repos/Fldicoahkiin/tuanbo-link-console/releases/42/assets?name=Tuanbo%20Link.exe');
  assert.equal(received.headers['content-length'], String(bytes.length));
  assert.equal(received.headers['transfer-encoding'], undefined);
  assert.ok(Buffer.concat(received.data).equals(bytes));
  assert.ok(received.chunks > 1, `${received.chunks} 次写入`);
});
