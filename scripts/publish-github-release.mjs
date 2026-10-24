// Publishes the GitHub release of a version once the update feed serves it (the server publishes a staged release
// on its own). It runs on the builder right after the upload, with the build's own files: it waits until the feed's
// latest.yml is byte for byte this build's, checks the files against the release signature and the build's release
// manifest, and uploads them to a release on the build's tag, marked Latest. Run by .github/workflows/release-windows.yml.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
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

const FEED_WAIT_MINUTES = 30;
const versionIn = feed => /^version: (.+)$/m.exec(feed.toString('utf8'))?.[1] ?? '（没有版本号）';

/** The feed's latest.yml once it is this build's; the server publishes within a few minutes of the upload. */
async function waitForFeed(url, expected) {
  const deadline = Date.now() + FEED_WAIT_MINUTES * 60_000;
  let served = null;
  for (;;) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      served = Buffer.from(await response.arrayBuffer());
      if (served.equals(expected)) return served;
    } catch (error) {
      console.log(`读取 ${url} 失败，稍后再读：${error.message}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`服务器 ${FEED_WAIT_MINUTES} 分钟内没有发布这个版本，更新源上仍是 ${served ? versionIn(served) : '（读不到）'}。到后台「软件更新」看自动发布的结果。`);
    }
    await new Promise(resolve => setTimeout(resolve, 20_000));
  }
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
  if (!version || !buildDirectory) throw new Error('用法：node scripts/publish-github-release.mjs <X.Y.Z> <apps/desktop/dist>');
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || !process.env.GITHUB_TOKEN) throw new Error(`只在 ${REPOSITORY} 的工作流里运行`);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const feedUrl = new URL(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).build.publish.url);
  const publicKeys = JSON.parse(await readFile(join(root, 'apps/desktop/src/main/link/release-public-keys.json'), 'utf8'));
  const installerName = `Tuanbo-Link-Console-${version}-x64.exe`;
  const read = name => readFile(join(buildDirectory, name));
  const [buildFeed, manifestBytes, installer, blockmap] = await Promise.all(['latest.yml', 'release-manifest.json', installerName, installerName + '.blockmap'].map(read));
  const feed = await waitForFeed(new URL('latest.yml', feedUrl), buildFeed);
  const head = await fetch(new URL(installerName, feedUrl), { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  if (!head.ok || Number(head.headers.get('content-length')) !== installer.length) throw new Error(`更新源上的 ${installerName} 与构建不一致：HTTP ${head.status}，大小 ${head.headers.get('content-length')}`);
  const { gitSha } = verifyPublishedRelease({ version, feed, buildFeed, manifest: JSON.parse(manifestBytes), installer, blockmap, publicKeys });
  console.log(`更新源已发布 ${version}：签名有效，latest.yml 与安装包和构建 ${gitSha} 的清单一致`);

  const tag = `v${version}`;
  if (await github(`/repos/${REPOSITORY}/releases/tags/${tag}`, { allow404: true })) throw new Error(`${tag} 的 release 已存在，不覆盖`);
  if ((await github(`/repos/${REPOSITORY}/releases?per_page=100`)).some(release => release.tag_name === tag)) throw new Error(`${tag} 有一个未完成的草稿 release，先在 GitHub 上处理它`);
  const ref = await github(`/repos/${REPOSITORY}/git/ref/tags/${tag}`, { allow404: true });
  const tagged = ref && (ref.object.type === 'tag' ? (await github(`/repos/${REPOSITORY}/git/tags/${ref.object.sha}`)).object.sha : ref.object.sha);
  if (ref && tagged !== gitSha) throw new Error(`标签 ${tag} 指向 ${tagged}，不是构建提交 ${gitSha}`);
  // Created with GITHUB_TOKEN when missing, which does not trigger Release Windows (push: tags: v*) again.
  if (!ref) await github(`/repos/${REPOSITORY}/git/refs`, { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: gitSha } });
  const notesPath = join(root, 'release-notes', `${version}.md`);
  const notes = existsSync(notesPath) ? (await readFile(notesPath, 'utf8')).trim() + '\n\n' : '';
  const body = `${notes}安装后需要用激活码激活（一码一机）。附件与更新源 ${new URL('latest.yml', feedUrl)} 提供的文件一致。`;
  const release = await github(`/repos/${REPOSITORY}/releases`, { method: 'POST', body: { tag_name: tag, name: `团播联动台 ${version}`, body, draft: true, make_latest: 'false' } });
  for (const [name, bytes] of [[installerName, installer], [installerName + '.blockmap', blockmap], ['latest.yml', feed], ['release-manifest.json', manifestBytes]]) {
    await github(`/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', base: 'https://uploads.github.com', body: bytes, type: 'application/octet-stream', timeout: 60 * 60_000 });
    console.log(`已上传 ${name}（${bytes.length} 字节）`);
  }
  const published = await github(`/repos/${REPOSITORY}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  console.log(`GitHub release 已发布并标为 Latest：${published.html_url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
