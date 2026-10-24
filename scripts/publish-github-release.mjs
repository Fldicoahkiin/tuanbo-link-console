// On the builder, after the upload: waits until the update feed serves this build's latest.yml byte for byte (the
// server publishes a staged release on its own), then turns the draft GitHub release into the published one marked
// Latest. Run by the transfer job of .github/workflows/release-windows.yml; a re-run after success changes nothing.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY, findRelease, github } from './github-releases.mjs';

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
      if (served.equals(expected)) return;
    } catch (error) {
      console.log(`读取 ${url} 失败，稍后再读：${error.message}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`服务器 ${FEED_WAIT_MINUTES} 分钟内没有发布这个版本，更新源上仍是 ${served ? versionIn(served) : '（读不到）'}。到后台「软件更新」看自动发布的结果。`);
    }
    await new Promise(resolve => setTimeout(resolve, 20_000));
  }
}

const [version, dist] = process.argv.slice(2);
if (!version || !dist) throw new Error('用法：node scripts/publish-github-release.mjs <X.Y.Z> <apps/desktop/dist>');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const feedUrl = new URL(JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).build.publish.url);
const installerName = `Tuanbo-Link-Console-${version}-x64.exe`;
const [buildFeed, installer] = await Promise.all([readFile(join(dist, 'latest.yml')), readFile(join(dist, installerName))]);
await waitForFeed(new URL('latest.yml', feedUrl), buildFeed);
const head = await fetch(new URL(installerName, feedUrl), { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
if (!head.ok || Number(head.headers.get('content-length')) !== installer.length) throw new Error(`更新源上的 ${installerName} 与构建不一致：HTTP ${head.status}，大小 ${head.headers.get('content-length')}`);
console.log(`更新源已发布 ${version}：latest.yml 与这次构建逐字节相同，安装包大小一致`);

const tag = `v${version}`;
const release = await findRelease(tag);
if (!release) throw new Error(`没有 ${tag} 的 release`);
if (!release.draft) {
  console.log(`${tag} 已经是正式 release：${release.html_url}`);
} else {
  const published = await github(`/repos/${REPOSITORY}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  console.log(`GitHub release 已发布并标为 Latest：${published.html_url}`);
}
