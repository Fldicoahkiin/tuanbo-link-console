import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FEED_URL, compareVersions, pendingDrafts } from './relay-release.mjs';

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
  assert.ok(compareVersions('0.5.10', '0.5.9') > 0);
  assert.equal(compareVersions('0.5.0', '0.5.0'), 0);
});
