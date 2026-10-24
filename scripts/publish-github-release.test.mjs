import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { verifyPublishedRelease } from './publish-github-release.mjs';
import { signUpdateMetadata } from './release-config.mjs';

const installerName = 'Tuanbo-Link-Console-0.5.0-x64.exe';
const installer = Buffer.from('installer bytes');
const blockmap = Buffer.from('blockmap bytes');
const sha512 = createHash('sha512').update(installer).digest('base64');
const unsigned = `version: 0.5.0\nfiles:\n  - url: ${installerName}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${installerName}\nsha512: ${sha512}\nreleaseDate: '2026-11-02T03:04:05.678Z'\n`;
const key = generateKeyPairSync('ed25519');
const publicKeys = { 'release-2026-10-a': key.publicKey.export({ type: 'spki', format: 'pem' }) };
const feed = Buffer.from(signUpdateMetadata(unsigned, { installerName, installerBytes: installer, privateKey: key.privateKey, kid: 'release-2026-10-a', publicKeys }));
const record = (name, bytes) => ({ path: 'apps/desktop/dist/' + name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const manifest = (changes = {}) => ({ version: '0.5.0', gitSha: 'a'.repeat(40), gitWorkingTreeDirty: false, summary: { checksFailed: 0 }, releaseSignature: { kid: 'release-2026-10-a' },
  artifacts: [record(installerName, installer), record(installerName + '.blockmap', blockmap), record('latest.yml', feed)], ...changes });
const input = (changes = {}) => ({ version: '0.5.0', feed, buildFeed: feed, manifest: manifest(), installer, blockmap, publicKeys, ...changes });

test('更新源上的文件与构建一致时，返回 tag 要指向的构建提交', () => {
  assert.deepEqual(verifyPublishedRelease(input()), { gitSha: 'a'.repeat(40), installerName });
});

test('任何一处对不上都拒绝发布 GitHub release', () => {
  const cases = [
    [{ version: '0.5' }, /X\.Y\.Z/],
    [{ buildFeed: Buffer.from(unsigned) }, /与这次构建留下的不一致/],
    [{ feed: Buffer.from(unsigned), buildFeed: Buffer.from(unsigned) }, /没有发布签名/],
    [{ installer: Buffer.from('another installer') }, /sha512|files/],
    [{ blockmap: Buffer.from('another blockmap') }, /blockmap 与构建清单不一致/],
    [{ manifest: manifest({ version: '0.5.1' }) }, /版本、提交或检查结果不符/],
    [{ manifest: manifest({ gitWorkingTreeDirty: true }) }, /版本、提交或检查结果不符/],
    [{ manifest: manifest({ summary: { checksFailed: 1 } }) }, /版本、提交或检查结果不符/],
    [{ manifest: manifest({ releaseSignature: { kid: 'release-2026-10-b' } }) }, /签名密钥/],
    [{ publicKeys: { 'release-2026-10-b': publicKeys['release-2026-10-a'] } }, /没有内置的密钥/]
  ];
  for (const [changes, error] of cases) assert.throws(() => verifyPublishedRelease(input(changes)), error, JSON.stringify(Object.keys(changes)));
});
