import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNewerRelease, compareStableVersions, signUpdateMetadata, verifyUpdateSignature, developmentAccessIn, readAsarFile, releaseTagPlan, validatePackagedUpdateConfig, validateReleaseVersion, validateUpdateMetadata, versionTags, websiteRelease } from './release-config.mjs';

const publish = { provider: 'generic', url: 'https://updates.tuanbo-link.jinhefilm.com/windows/x64/' };

test('接受公司更新源，包括 YAML 引号和 updaterCacheDirName', () => {
  assert.doesNotThrow(() => validatePackagedUpdateConfig(`provider: generic\nurl: '${publish.url}'\nupdaterCacheDirName: tblink-updater\n`, publish));
});

test('拒绝历史 GitHub 源和不同的下载域名', () => {
  assert.throws(() => validatePackagedUpdateConfig('provider: github\nowner: JinHe9527\nrepo: tuanbo-yijianchufa\n', publish), /不一致/);
  assert.throws(() => validatePackagedUpdateConfig('provider: generic\nurl: https://other.example/\n', publish), /不一致/);
});

test('拒绝伪装在注释中的配置和重复 YAML 键', () => {
  assert.throws(() => validatePackagedUpdateConfig(`# provider: generic\n# url: ${publish.url}\nprovider: github\n`, publish));
  assert.throws(() => validatePackagedUpdateConfig(`provider: generic\nurl: ${publish.url}\nurl: https://other.example/\n`, publish));
});

test('拒绝非 HTTPS、带凭据或查询参数的源', () => {
  for (const url of ['http://updates.example/', 'https://user:secret@updates.example/', 'https://updates.example/?token=secret']) {
    assert.throws(() => validatePackagedUpdateConfig(`provider: generic\nurl: ${url}\n`, { provider: 'generic', url }), /HTTPS/);
  }
  assert.throws(() => validatePackagedUpdateConfig(`provider: generic\nurl: ${publish.url}\ntoken: secret\n`, publish), /凭据/);
});

test('根包、桌面包和 v 标签必须对应同一稳定版本', () => {
  assert.equal(validateReleaseVersion({ version: '0.4.27' }, { version: '0.4.27' }, 'v0.4.27'), '0.4.27');
  assert.throws(() => validateReleaseVersion({ version: '0.4.26' }, { version: '0.4.27' }), /不一致/);
  assert.throws(() => validateReleaseVersion({ version: '0.4.27' }, { version: '0.4.27' }, 'desktop-0.4.27-20260925'), /标签/);
  for (const version of ['0.4.27-beta.1', '01.4.27', '0.4']) {
    assert.throws(() => validateReleaseVersion({ version }, { version }), /稳定版本/);
  }
});

const installerName = 'Tuanbo-Link-Console-0.5.0-x64.exe';
const installerBytes = Buffer.from('installer bytes');
const installerSha512 = createHash('sha512').update(installerBytes).digest('base64');
const latest = (overrides = {}) => {
  const values = { version: '0.5.0', url: installerName, sha512: installerSha512, size: installerBytes.length, path: installerName, releaseDate: "'2026-11-02T03:04:05.678Z'", ...overrides };
  return `version: ${values.version}\nfiles:\n  - url: ${values.url}\n    sha512: ${values.sha512}\n    size: ${values.size}\npath: ${values.path}\nsha512: ${values.sha512}\n${values.releaseDate === null ? '' : `releaseDate: ${values.releaseDate}\n`}`;
};

test('latest.yml 必须对应同一安装包，并带可解析的发布日期', () => {
  const expected = { version: '0.5.0', installerName, installerBytes };
  assert.deepEqual(validateUpdateMetadata(latest(), expected), { version: '0.5.0', releaseDate: '2026-11-02T03:04:05.678Z', sha512: installerSha512 });
  assert.throws(() => validateUpdateMetadata(latest({ version: '0.4.29' }), expected), /版本/);
  assert.throws(() => validateUpdateMetadata(latest({ sha512: 'AAAA' }), expected), /sha512/);
  assert.throws(() => validateUpdateMetadata(latest({ size: 1 }), expected), /files/);
  assert.throws(() => validateUpdateMetadata(latest({ url: 'other.exe' }), expected), /files/);
  assert.throws(() => validateUpdateMetadata(latest({ releaseDate: null }), expected), /releaseDate/);
  assert.throws(() => validateUpdateMetadata(latest({ releaseDate: "'yesterday'" }), expected), /releaseDate/);
});

test('识别开发构建才有的本机测试入口', () => {
  assert.deepEqual(developmentAccessIn(Buffer.from("process.env.TBLINK_LOCAL_TEST_ACCESS, existsSync(join(app.getAppPath(), '.local-test-access'))")), ['TBLINK_LOCAL_TEST_ACCESS', '.local-test-access']);
  assert.deepEqual(developmentAccessIn(Buffer.from('message: "本机开发测试通道已启用"')), ['本机开发测试通道']);
  assert.deepEqual(developmentAccessIn(Buffer.from('const status = (await getLicenseService()).status();')), []);
});

test('从 asar 读取单个文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tblink-asar-'));
  const content = Buffer.from(JSON.stringify({ name: '@tb/desktop', productName: '团播联动台' }));
  const other = Buffer.from('main bundle');
  const index = Buffer.from(JSON.stringify({ files: { 'package.json': { size: content.length, offset: String(other.length) }, out: { files: {} }, 'main.js': { size: other.length, offset: '0' } } }));
  const padded = Buffer.alloc(Math.ceil(index.length / 4) * 4);
  index.copy(padded);
  const header = Buffer.alloc(8 + padded.length);
  header.writeUInt32LE(4 + padded.length, 0);
  header.writeUInt32LE(index.length, 4);
  padded.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  const archive = join(directory, 'app.asar');
  writeFileSync(archive, Buffer.concat([size, header, other, content]));
  assert.deepEqual(JSON.parse(readAsarFile(archive, 'package.json').toString('utf8')), { name: '@tb/desktop', productName: '团播联动台' });
  assert.throws(() => readAsarFile(archive, 'missing.json'), /没有/);
});

test('官网下载信息由已发布的 latest.yml 生成，日期按北京时间', () => {
  const published = `version: 0.4.29\nfiles:\n  - url: Tuanbo-Link-Console-0.4.29-x64.exe\n    sha512: BJJm\n    size: 130125531\npath: Tuanbo-Link-Console-0.4.29-x64.exe\nsha512: BJJm\nreleaseDate: '2026-09-28T18:15:14.517Z'\n`;
  assert.deepEqual(websiteRelease(published, publish.url), {
    version: '0.4.29', date: '2026-09-29', size: 130125531,
    url: 'https://updates.tuanbo-link.jinhefilm.com/windows/x64/Tuanbo-Link-Console-0.4.29-x64.exe',
    source: 'https://updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml'
  });
  assert.throws(() => websiteRelease(published.replaceAll('0.4.29', '0.5.0-test.3'), publish.url), /正式版本/);
  assert.throws(() => websiteRelease(published.replace('path: Tuanbo-Link-Console-0.4.29-x64.exe', 'path: Tuanbo-Link-Test-NoActivation-0.4.29-x64.exe'), publish.url), /正式安装包/);
  assert.throws(() => websiteRelease(published.replace(/releaseDate.*\n/, ''), publish.url), /releaseDate/);
});

test('正式版本号按数字比较', () => {
  assert.ok(compareStableVersions('0.5.0', '0.4.57') > 0);
  assert.ok(compareStableVersions('0.4.10', '0.4.9') > 0);
  assert.equal(compareStableVersions('1.0.0', '1.0.0'), 0);
  assert.throws(() => compareStableVersions('0.5.0-test.1', '0.4.0'), /X\.Y\.Z/);
});

test('正式版本必须高于其他标签和线上更新源，自己的标签只能在本次提交上', () => {
  const tags = [{ name: 'v0.4.28', commit: 'a' }, { name: 'v0.4.29', commit: 'b' }, { name: 'desktop-0.4.27-20260925', commit: 'c' }];
  assert.doesNotThrow(() => assertNewerRelease('0.5.0', { tags, head: 'h', feedVersion: '0.4.29' }));
  assert.doesNotThrow(() => assertNewerRelease('0.5.0', { tags: [...tags, { name: 'v0.5.0', commit: 'h' }], head: 'h', feedVersion: '0.4.29' }));
  assert.throws(() => assertNewerRelease('0.5.0', { tags: [...tags, { name: 'v0.5.0', commit: 'x' }], head: 'h', feedVersion: '0.4.29' }), /另一个提交/);
  assert.throws(() => assertNewerRelease('0.4.29', { tags, head: 'h', feedVersion: '0.4.28' }), /另一个提交/);
  assert.throws(() => assertNewerRelease('0.4.20', { tags, head: 'h', feedVersion: '0.4.19' }), /不高于已有标签 v0\.4\.28/);
  assert.throws(() => assertNewerRelease('0.4.30', { tags, head: 'h', feedVersion: '0.4.30' }), /不高于更新源/);
  assert.throws(() => assertNewerRelease('0.4.30', { tags: [...tags, { name: 'v0.5.0', commit: 'z' }], head: 'h', feedVersion: '0.4.29' }), /v0\.5\.0/);
});

test('发版打标签：没有就建，已在本次提交上就保留，没发布过的才能挪到新提交', () => {
  const tags = [{ name: 'v0.5.2', commit: 'a' }];
  const input = { tags, head: 'h', feedVersion: '0.5.2', hasRelease: false };
  assert.equal(releaseTagPlan('0.5.3', input), 'create');
  assert.equal(releaseTagPlan('0.5.3', { ...input, tags: [...tags, { name: 'v0.5.3', commit: 'h' }] }), 'keep');
  // 0.5.3 打了 tag 但打包失败、没出过草稿：修好后同一个版本号挪到修复提交上。
  assert.equal(releaseTagPlan('0.5.3', { ...input, tags: [...tags, { name: 'v0.5.3', commit: 'old' }] }), 'move');
  assert.throws(() => releaseTagPlan('0.5.3', { ...input, tags: [...tags, { name: 'v0.5.3', commit: 'old' }], hasRelease: true }), /已有 release/);
  assert.throws(() => releaseTagPlan('0.5.3', { ...input, tags: [...tags, { name: 'v0.5.3', commit: 'old' }], feedVersion: '0.5.3' }), /不高于更新源/);
  assert.throws(() => releaseTagPlan('0.5.3', { ...input, tags: [...tags, { name: 'v0.5.4', commit: 'b' }] }), /不高于已有标签 v0\.5\.4/);
});

test('标签列表：附注标签取它指向的提交', () => {
  assert.deepEqual(versionTags('v0.5.2 t1 c1\nv0.5.0 c0 \n'), [{ name: 'v0.5.2', commit: 'c1' }, { name: 'v0.5.0', commit: 'c0' }]);
});

test('发布签名写进 latest.yml，只能由客户端内置的密钥签发，并绑定这个安装包', () => {
  const key = generateKeyPairSync('ed25519');
  const publicKeys = { 'release-2026-10-a': key.publicKey.export({ type: 'spki', format: 'pem' }) };
  const input = { installerName, installerBytes, publicKeys };
  const signed = signUpdateMetadata(latest(), { ...input, privateKey: key.privateKey, kid: 'release-2026-10-a' });
  assert.equal(verifyUpdateSignature(signed, input), 'release-2026-10-a');
  assert.equal(verifyUpdateSignature(latest(), input), null);
  assert.throws(() => signUpdateMetadata(signed, { ...input, privateKey: key.privateKey, kid: 'release-2026-10-a' }), /已经带有/);
  assert.throws(() => signUpdateMetadata(latest(), { ...input, privateKey: key.privateKey, kid: 'release-2026-10-z' }), /没有内置密钥/);
  const other = generateKeyPairSync('ed25519');
  assert.throws(() => signUpdateMetadata(latest(), { ...input, privateKey: other.privateKey, kid: 'release-2026-10-a' }), /不匹配/);
  assert.throws(() => verifyUpdateSignature(signed, { ...input, installerBytes: Buffer.from('forged') }), /sha512|files/);
  assert.throws(() => verifyUpdateSignature(signed.replace(/signature: (\S)/, (_m, c) => `signature: ${c === 'A' ? 'B' : 'A'}`), input), /签名无效/);
});
