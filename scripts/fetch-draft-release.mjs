// On the builder: downloads the release the cloud build drafted (or already published, on a re-run) and checks every
// file against the release manifest before anything is uploaded to the server.
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadAsset, findRelease } from './github-releases.mjs';

const [version, commit, dist] = process.argv.slice(2);
if (!version || !/^[a-f0-9]{40}$/.test(commit ?? '') || !dist) throw new Error('用法：node scripts/fetch-draft-release.mjs <X.Y.Z> <提交号> <apps/desktop/dist>');
const tag = `v${version}`;
const release = await findRelease(tag);
if (!release) throw new Error(`没有 ${tag} 的 release：云端构建没有跑完，或草稿被删掉了`);
const installer = `Tuanbo-Link-Console-${version}-x64.exe`;
await mkdir(dist, { recursive: true });
for (const name of ['release-manifest.json', 'latest.yml', installer, `${installer}.blockmap`]) {
  const asset = release.assets.find(item => item.name === name);
  if (!asset) throw new Error(`${tag} 的 release 缺少 ${name}`);
  const { size } = await downloadAsset(asset, join(dist, name));
  console.log(`已下载 ${name}（${size} 字节）`);
}
const manifest = JSON.parse(await readFile(join(dist, 'release-manifest.json'), 'utf8'));
if (manifest.version !== version || manifest.gitSha !== commit || manifest.gitWorkingTreeDirty !== false || manifest.summary?.checksFailed !== 0 || !manifest.releaseSignature) {
  throw new Error('构建清单的版本、提交、检查结果或发布签名不符');
}
for (const name of [installer, `${installer}.blockmap`, 'latest.yml']) {
  const records = manifest.artifacts.filter(item => item.path === `apps/desktop/dist/${name}`);
  const bytes = await readFile(join(dist, name));
  if (records.length !== 1 || records[0].bytes !== bytes.length || records[0].sha256 !== createHash('sha256').update(bytes).digest('hex')) {
    throw new Error(`${name} 与构建清单不一致`);
  }
}
console.log(`${tag} 的四个文件与构建清单一致（构建提交 ${commit}）`);
