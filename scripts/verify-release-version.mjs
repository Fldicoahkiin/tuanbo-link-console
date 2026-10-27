import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertNewerRelease, feedVersionOf, validateReleaseVersion, versionTags } from './release-config.mjs';
import { readReleaseNotes } from './release-notes.mjs';

// Default: root and desktop package agree on an X.Y.Z version that has release-notes/X.Y.Z.md (every verify run).
// --release: also newer than every other release tag and than the live feed (release builds only;
// package.json keeps the last released version between release commits).
const args = process.argv.slice(2);
const release = args[0] === '--release';
const tag = release ? args[1] : args[0];
if (args.length > (release ? 2 : 1)) throw new Error('用法：node scripts/verify-release-version.mjs [--release] [vX.Y.Z]');
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const desktopPackage = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const version = validateReleaseVersion(rootPackage, desktopPackage, tag);
if (!readReleaseNotes('release-notes').some(note => note.version === version)) {
  throw new Error(`缺少 release-notes/${version}.md：GitHub Release、官网和软件里的更新日志都从它生成，见 release-notes/README.md`);
}
if (release) {
  const git = (gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim();
  const tags = versionTags(git(['for-each-ref', 'refs/tags/v*', '--format=%(refname:short) %(objectname) %(*objectname)']));
  const feedVersion = await feedVersionOf(desktopPackage.build.publish.url);
  assertNewerRelease(version, { tags, head: git(['rev-parse', 'HEAD']), feedVersion });
  console.log(`正式版本 ${version} 高于已有标签和线上更新源 ${feedVersion}${tag ? `，标签：${tag}` : ''}`);
} else {
  console.log(`版本一致：${version}${tag ? `，标签：${tag}` : ''}`);
}
