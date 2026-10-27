// First job of a dispatched Release Windows run: tags the commit the run was started on as vX.Y.Z (the version in its
// package.json) through the GitHub API, so a release needs no git push from anyone's computer. The caller names the
// commit it means to release; a branch that moved since then is refused. A tag whose version never reached the feed
// or a GitHub release moves to the new commit (releaseTagPlan), so a release that failed before publishing keeps its
// version number. Tags made with the workflow's token start no other workflow run: this run builds the release itself.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { REPOSITORY, findRelease, github } from './github-releases.mjs';
import { feedVersionOf, releaseTagPlan, validateReleaseVersion, versionTags } from './release-config.mjs';
import { readReleaseNotes } from './release-notes.mjs';

const [expected] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(expected ?? '')) throw new Error('用法：node scripts/tag-release.mjs <要发布的 40 位提交号>');
const head = process.env.GITHUB_SHA;
if (head !== expected) throw new Error(`分支最新提交是 ${head}，不是要发布的 ${expected}；核对后用最新的提交号重新触发`);
const desktopPackage = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const version = validateReleaseVersion(JSON.parse(readFileSync('package.json', 'utf8')), desktopPackage);
if (!readReleaseNotes('release-notes').some(note => note.version === version)) throw new Error(`缺少 release-notes/${version}.md，见 release-notes/README.md`);
const tag = `v${version}`;
const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 15_000 }).trim();
const tags = versionTags(git(['for-each-ref', 'refs/tags/v*', '--format=%(refname:short) %(objectname) %(*objectname)']));
const feedVersion = await feedVersionOf(desktopPackage.build.publish.url);
const plan = releaseTagPlan(version, { tags, head, feedVersion, hasRelease: (await findRelease(tag)) !== null });
switch (plan) {
  case 'create':
    await github(`/repos/${REPOSITORY}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: head } });
    console.log(`已在 ${head} 上建标签 ${tag}`);
    break;
  case 'move':
    await github(`/repos/${REPOSITORY}/git/refs/tags/${tag}`, { method: 'PATCH', body: { sha: head, force: true } });
    console.log(`${tag} 没有发布过，标签从 ${tags.find(item => item.name === tag)?.commit} 挪到 ${head}`);
    break;
  case 'keep':
    console.log(`${tag} 已经在 ${head} 上`);
    break;
  default:
    throw new Error(`未知的标签处理：${plan}`);
}
appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
