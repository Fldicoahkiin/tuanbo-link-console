// Publishes the GitHub release of a version the update feed already serves (the owner published it in the
// console). The files come from the public feed and must match the release signature and the build's release
// manifest; the tag points at the build commit. Run by .github/workflows/publish-github-release.yml.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyUpdateSignature } from './release-config.mjs';

const REPOSITORY = 'Fldicoahkiin/tuanbo-link-console';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The feed's files are the build's: signed by a client key, recorded in its manifest, and the same latest.yml. */
export function verifyPublishedRelease({ version, feed, buildFeed, manifest, installer, blockmap, publicKeys }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`不是 X.Y.Z 正式版本号：${version}`);
  if (!feed.equals(buildFeed)) throw new Error('更新源上的 latest.yml 与这次构建留下的不一致');
  const installerName = `Tuanbo-Link-Console-${version}-x64.exe`;
  const kid = verifyUpdateSignature(feed.toString('utf8'), { installerName, installerBytes: installer, publicKeys });
  if (!kid) throw new Error('更新源上的 latest.yml 没有发布签名');
  if (manifest.version !== version || typeof manifest.gitSha !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.gitSha)
      || manifest.gitWorkingTreeDirty !== false || manifest.summary?.checksFailed !== 0) throw new Error('构建清单的版本、提交或检查结果不符');
  if (manifest.releaseSignature?.kid !== kid) throw new Error('构建清单记录的签名密钥与 latest.yml 不一致');
  for (const [name, bytes] of [[installerName, installer], [installerName + '.blockmap', blockmap], ['latest.yml', feed]]) {
    const records = manifest.artifacts.filter(item => item.path === 'apps/desktop/dist/' + name);
    if (records.length !== 1 || records[0].bytes !== bytes.length || records[0].sha256 !== sha256(bytes)) throw new Error(`${name} 与构建清单不一致`);
  }
  return { gitSha: manifest.gitSha, installerName };
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60 * 60_000) });
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function github(path, { method = 'GET', body, base = 'https://api.github.com', type = 'application/json', timeout = 60_000, allow404 = false } = {}) {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': type } : {}) },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${method} ${path} 失败：HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function main([version, buildDirectory]) {
  if (!version || !buildDirectory) throw new Error('用法：node scripts/publish-github-release.mjs <X.Y.Z> <Release Windows 产物目录>');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || !process.env.GITHUB_TOKEN) throw new Error(`只在 ${REPOSITORY} 的工作流里运行`);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const notes = await readFile(join(root, 'release-notes', `${version}.md`), 'utf8');
  const feedUrl = new URL(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).build.publish.url);
  const publicKeys = JSON.parse(await readFile(join(root, 'apps/desktop/src/main/link/release-public-keys.json'), 'utf8'));
  const feed = await download(new URL('latest.yml', feedUrl));
  const installerName = `Tuanbo-Link-Console-${version}-x64.exe`;
  const [installer, blockmap] = [await download(new URL(installerName, feedUrl)), await download(new URL(installerName + '.blockmap', feedUrl))];
  const manifestBytes = await readFile(join(buildDirectory, 'release-manifest.json'));
  const { gitSha } = verifyPublishedRelease({ version, feed, buildFeed: await readFile(join(buildDirectory, 'latest.yml')), manifest: JSON.parse(manifestBytes),
    installer, blockmap, publicKeys });
  console.log(`更新源上的 ${version} 通过校验：签名有效，安装包、blockmap、latest.yml 与构建 ${gitSha} 的清单一致`);

  const tag = `v${version}`;
  if (await github(`/repos/${REPOSITORY}/releases/tags/${tag}`, { allow404: true })) throw new Error(`${tag} 的 release 已存在，不覆盖`);
  if ((await github(`/repos/${REPOSITORY}/releases?per_page=100`)).some(release => release.tag_name === tag)) throw new Error(`${tag} 有一个未完成的草稿 release，先在 GitHub 上处理它`);
  const ref = await github(`/repos/${REPOSITORY}/git/ref/tags/${tag}`, { allow404: true });
  if (ref && ref.object.sha !== gitSha) throw new Error(`标签 ${tag} 已存在但指向 ${ref.object.sha}，不是构建提交 ${gitSha}`);
  // A tag created with GITHUB_TOKEN does not trigger Release Windows (push: tags: v*), so nothing is rebuilt.
  if (!ref) await github(`/repos/${REPOSITORY}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: gitSha } });
  const body = `${notes.trim()}\n\n安装后需要用激活码激活（一码一机）。附件与更新源 ${new URL('latest.yml', feedUrl)} 提供的文件一致。`;
  const release = await github(`/repos/${REPOSITORY}/releases`, { method: 'POST', body: { tag_name: tag, name: `团播联动台 ${version}`, body, draft: true, make_latest: 'false' } });
  for (const [name, bytes] of [[installerName, installer], [installerName + '.blockmap', blockmap], ['latest.yml', feed], ['release-manifest.json', manifestBytes]]) {
    await github(`/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', base: 'https://uploads.github.com', body: bytes, type: 'application/octet-stream', timeout: 60 * 60_000 });
    console.log(`已上传 ${name}（${bytes.length} 字节）`);
  }
  const published = await github(`/repos/${REPOSITORY}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  console.log(`GitHub release 已发布并标为 Latest：${published.html_url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
