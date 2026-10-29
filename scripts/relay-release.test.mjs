import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { DELTA_FORMAT, FEED_URL, compareVersions, deltaPlan, incompleteDrafts, pendingDrafts, readBlockmap, writeDelta } from './relay-release.mjs';

test('搬运脚本的更新源地址与安装包里的一致', () => {
  assert.equal(FEED_URL, JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8')).build.publish.url);
});

test('只搬运附件齐全的 vX.Y.Z 草稿，版本高的在前', () => {
  const files = version => [`Tuanbo-Link-Console-${version}-x64.exe`, `Tuanbo-Link-Console-${version}-x64.exe.blockmap`, 'latest.yml', 'release-manifest.json']
    .map(name => ({ name, state: 'uploaded' }));
  const draft = (version, assets = files(version)) => ({ tag_name: `v${version}`, draft: true, assets });
  const releases = [
    draft('0.5.1'), draft('0.5.10'), draft('0.5.2', files('0.5.2').slice(1)),
    draft('0.5.3', files('0.5.3').map(asset => ({ ...asset, state: 'starter' }))),
    { ...draft('0.5.4'), draft: false }, draft('build-assets-beauty-2dfd72cfcae9'.replace(/^v/, ''))
  ];
  assert.deepEqual(pendingDrafts(releases).map(release => release.tag_name), ['v0.5.10', 'v0.5.1']);
  assert.deepEqual(incompleteDrafts([...releases, draft('0.5.11', [])]), [{ tag: 'v0.5.2', files: 3 }, { tag: 'v0.5.3', files: 0 }, { tag: 'v0.5.11', files: 0 }]);
  assert.ok(compareVersions('0.5.10', '0.5.9') > 0);
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
});

test('只传变化部分的格式与服务器接收脚本一致', () => {
  const receiver = readFileSync(new URL('../apps/licensing-server/deploy/receive-update.py', import.meta.url), 'utf8');
  assert.equal(/^DELTA_FORMAT = '(.+)'$/m.exec(receiver)?.[1], DELTA_FORMAT);
});

const blockmap = blocks => gzipSync(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, checksums: blocks.map(([checksum]) => checksum), sizes: blocks.map(([, size]) => size) }] }));

test('只传 blockmap 里旧版没有的块，和 electron-updater 的计划一致', () => {
  assert.throws(() => readBlockmap(gzipSync(JSON.stringify({ files: [{ name: 'file', offset: 4, checksums: ['a'], sizes: [3] }] }))), /从头开始/);
  assert.throws(() => readBlockmap(gzipSync(JSON.stringify({ files: [] }))), /从头开始/);
  const oldMap = readBlockmap(blockmap([['a', 3], ['b', 4], ['c', 5], ['d', 2]]));
  const newMap = readBlockmap(blockmap([['b', 4], ['c', 5], ['x', 2], ['y', 1], ['a', 3], ['d', 6], ['b', 4]]));
  assert.equal(newMap.size, 25);
  // b and c sit next to each other in the old file, so one copy; x, y and d (same checksum, other size) are sent.
  assert.deepEqual(deltaPlan(oldMap, newMap), {
    ops: [[0, 3, 9], [1, 3], [0, 0, 3], [1, 6], [0, 3, 4]],
    sent: [{ start: 9, length: 3 }, { start: 15, length: 6 }],
    bytes: 9
  });
});

test('按计划写出的文件能拼回新安装包，只读变化的那几段', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-delta-'));
  try {
    const base = Buffer.from('aaabbbbcccccdd');
    const installer = Buffer.from('bbbbcccccXYaaaDDDDDDbbbb');
    const plan = deltaPlan(readBlockmap(blockmap([['a', 3], ['b', 4], ['c', 5], ['d', 2]])), readBlockmap(blockmap([['b', 4], ['c', 5], ['x', 2], ['a', 3], ['D', 6], ['b', 4]])));
    const reads = [];
    const read = async (start, length) => { reads.push([start, length]); return installer.subarray(start, start + length); };
    await writeDelta({ plan, base: { file: 'Tuanbo-Link-Console-0.5.5-x64.exe', size: base.length }, size: installer.length, read, output: join(directory, 'new.exe.delta') });
    assert.deepEqual(reads, [[9, 2], [14, 6]]);
    await assert.rejects(writeDelta({ plan, base: { file: 'x', size: 1 }, size: 1, read: async () => Buffer.alloc(1), output: join(directory, 'short.delta') }), /只读到 1 字节/);
    const delta = readFileSync(join(directory, 'new.exe.delta'));
    const line = delta.indexOf('\n');
    const header = JSON.parse(delta.subarray(0, line).toString('utf8'));
    assert.deepEqual(header, { format: DELTA_FORMAT, base: { file: 'Tuanbo-Link-Console-0.5.5-x64.exe', size: 14 }, size: 24, ops: plan.ops });
    let carried = line + 1;
    const rebuilt = Buffer.concat(header.ops.map(op => {
      if (op[0] === 0) return base.subarray(op[1], op[1] + op[2]);
      carried += op[1];
      return delta.subarray(carried - op[1], carried);
    }));
    assert.equal(carried, delta.length);
    assert.deepEqual(rebuilt, installer);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
