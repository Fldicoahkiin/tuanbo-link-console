// Writes apps/licensing-server/web/release.json (the download page's version, date and link) from the
// published latest.yml. Run it after publish-update.py, commit the result; CI then deploys the website.
import { readFileSync, writeFileSync } from 'node:fs';
import { websiteRelease } from './release-config.mjs';

const args = process.argv.slice(2);
if (args.length > 1) throw new Error('用法：node scripts/write-website-release.mjs [已发布的 latest.yml 路径；省略时读取线上更新源]');
const feedUrl = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8')).build.publish.url;
const live = args.length === 0;
const text = live ? await fetchText(new URL('latest.yml', feedUrl)) : readFileSync(args[0], 'utf8');
const { size, ...release } = websiteRelease(text, feedUrl);
if (live) {
  // The page must never link to an installer the feed does not serve.
  const response = await fetch(release.url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || Number(response.headers.get('content-length')) !== size) {
    throw new Error(`更新源上的安装包与 latest.yml 不一致：HTTP ${response.status}，大小 ${response.headers.get('content-length')}，应为 ${size}`);
  }
}
writeFileSync('apps/licensing-server/web/release.json', `${JSON.stringify(release, null, 2)}\n`);
console.log(`官网下载信息已更新：${release.version}（${release.date}）`);

async function fetchText(url) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`读取 ${url} 失败：HTTP ${response.status}`);
  return response.text();
}
