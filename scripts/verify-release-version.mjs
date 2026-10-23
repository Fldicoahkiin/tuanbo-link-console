import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { assertNewerRelease, validateReleaseVersion } from './release-config.mjs';

// Default: root and desktop package agree on an X.Y.Z version (every verify run).
// --release: also newer than every other release tag and than the live feed (release builds only;
// package.json keeps the last released version between release commits).
const args = process.argv.slice(2);
const release = args[0] === '--release';
const tag = release ? args[1] : args[0];
if (args.length > (release ? 2 : 1)) throw new Error('用法：node scripts/verify-release-version.mjs [--release] [vX.Y.Z]');
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const desktopPackage = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const version = validateReleaseVersion(rootPackage, desktopPackage, tag);
if (release) {
  const git = (gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
  const tags = git(['for-each-ref', 'refs/tags/v*', '--format=%(refname:short) %(objectname) %(*objectname)'])
    .split('\n').filter(Boolean).map(line => {
      const [name, object, peeled] = line.split(' ');
      return { name, commit: peeled || object };
    });
  const feed = new URL('latest.yml', desktopPackage.build.publish.url);
  const response = await fetch(feed, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`读取线上更新源失败：${feed} HTTP ${response.status}`);
  const feedVersion = load(await response.text())?.version;
  if (typeof feedVersion !== 'string') throw new Error('线上 latest.yml 没有版本号');
  assertNewerRelease(version, { tags, head: git(['rev-parse', 'HEAD']), feedVersion });
  console.log(`正式版本 ${version} 高于已有标签和线上更新源 ${feedVersion}${tag ? `，标签：${tag}` : ''}`);
} else {
  console.log(`版本一致：${version}${tag ? `，标签：${tag}` : ''}`);
}
