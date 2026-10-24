// The cloud build puts its signed release into a draft GitHub release on the tag: the installer, its blockmap,
// latest.yml and the release manifest. The builder downloads that draft, uploads it to the server and publishes the
// release once the feed serves it. A re-run replaces the draft's files; a published release is never changed.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY, findRelease, github, uploadAsset } from './github-releases.mjs';

const [version, dist] = process.argv.slice(2);
if (!version || !dist) throw new Error('用法：node scripts/draft-github-release.mjs <X.Y.Z> <apps/desktop/dist>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tag = `v${version}`;
const manifestBytes = await readFile(join(dist, 'release-manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.version !== version || manifest.gitSha !== process.env.GITHUB_SHA || !manifest.releaseSignature) {
  throw new Error('构建清单的版本、提交或发布签名与这次运行不符');
}
const installer = `Tuanbo-Link-Console-${version}-x64.exe`;
const names = [installer, `${installer}.blockmap`, 'latest.yml', 'release-manifest.json'];

const existing = await findRelease(tag);
if (existing && !existing.draft) throw new Error(`${tag} 已经是正式 release，不再改动`);
const notesPath = join(root, 'release-notes', `${version}.md`);
const notes = existsSync(notesPath) ? (await readFile(notesPath, 'utf8')).trim() + '\n\n' : '';
const body = `${notes}安装后需要用激活码激活（一码一机）。附件与更新源 https://updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml 提供的文件一致。`;
const release = existing ?? await github(`/repos/${REPOSITORY}/releases`, { method: 'POST', body: { tag_name: tag, name: `团播联动台 ${version}`, body, draft: true, make_latest: 'false' } });
for (const asset of release.assets ?? []) {
  if (names.includes(asset.name)) await github(`/repos/${REPOSITORY}/releases/assets/${asset.id}`, { method: 'DELETE' });
}
for (const name of names) {
  const bytes = name === 'release-manifest.json' ? manifestBytes : await readFile(join(dist, name));
  await uploadAsset(release, name, bytes);
  console.log(`已上传到草稿 release ${tag}：${name}（${bytes.length} 字节）`);
}
