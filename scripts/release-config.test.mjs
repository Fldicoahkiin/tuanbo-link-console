import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePackagedUpdateConfig, validateReleaseVersion } from './release-config.mjs';

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
