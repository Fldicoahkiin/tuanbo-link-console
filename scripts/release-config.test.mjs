import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNewerRelease, compareStableVersions, embeddedDistributionChannel, readAsarFile, validatePackagedUpdateConfig, validateReleaseVersion, validateUpdateMetadata, websiteRelease } from './release-config.mjs';

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

test('识别编译进主进程的测试或内测分发，不把 schema 字面量当作分发', () => {
  assert.equal(embeddedDistributionChannel(Buffer.from('const internalDistribution = distributionSchema.parse({ channel: "portable-test", version: 1 });')), 'portable-test');
  assert.equal(embeddedDistributionChannel(Buffer.from('parse({"channel":"internal","publicKeys":{},"token":"x"})')), 'internal');
  assert.equal(embeddedDistributionChannel(Buffer.from('z.object({ channel: z.literal("portable-test"), version: z.literal(1) }); const d = null === null ? null : x;')), null);
});

test('从 asar 读取单个文件', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tblink-asar-'));
  const content = Buffer.from(JSON.stringify({ name: 'tuanbo-link-functional-test', productName: '团播联动台功能测试版' }));
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
  assert.deepEqual(JSON.parse(readAsarFile(archive, 'package.json').toString('utf8')), { name: 'tuanbo-link-functional-test', productName: '团播联动台功能测试版' });
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
