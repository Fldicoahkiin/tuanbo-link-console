import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { homepage, downloadPage, guidePage, layout, legalPage, LEGAL_PAGES } from './web/pages.mjs';
import { notesUpTo, readReleaseNotes } from '../../scripts/release-notes.mjs';

const root = new URL('./', import.meta.url), target = new URL('dist/web/', root);
const email = process.env.TBLINK_CONTACT_EMAIL ?? 'info@jinhefilm.com';
if (!/^[a-z0-9][a-z0-9._+-]*@jinhefilm\.com$/.test(email) || email.startsWith('admin@')) throw new Error('联系邮箱须为非 admin 的 jinhefilm.com 邮箱');
const release = JSON.parse(await readFile(new URL('web/release.json', root), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(release.version) || release.url !== `https://updates.tuanbo-link.jinhefilm.com/windows/x64/Tuanbo-Link-Console-${release.version}-x64.exe` || !/^\d{4}-\d{2}-\d{2}$/.test(release.date)) throw new Error('正式发行元数据无效');
// The download page lists the release notes of the released version and every earlier one; a later version's notes
// may already be written and stay hidden until the release flow points release.json at it.
const notes = notesUpTo(readReleaseNotes(fileURLToPath(new URL('../../release-notes/', root))), release.version);
if (notes[0]?.version !== release.version) throw new Error(`缺少 release-notes/${release.version}.md，官网下载页没有这一版的更新日志`);
await mkdir(target, { recursive: true });
for (const [entry, name] of [['main.ts', 'purchase.js'], ['site.ts', 'site.js']]) await build({ entryPoints: [fileURLToPath(new URL(`web/${entry}`, root))], outfile: fileURLToPath(new URL(name, target)), bundle: true, platform: 'browser', target: 'es2022', format: 'esm', minify: true });
const checkout = await readFile(new URL('web/checkout.html', root), 'utf8');
const pages = { 'index.html': homepage(), 'download/index.html': downloadPage(release, notes), 'guide/index.html': guidePage(), 'purchase/index.html': layout('购买授权', '/purchase/', `<div class="wrap page-intro"><p class="eyebrow">授权与订单</p><h1>购买团播联动台授权</h1><p class="lead">选择周期，保存凭据，付款后领取激活码。</p><p class="media-note">当前正式版本 ${release.version}。官网含开发预览，购买前请核对<a href="/download/">正式版本说明</a>。</p></div><div class="wrap checkout-page">${checkout}</div>`, true) };
for (const slug of LEGAL_PAGES) pages[`${slug}/index.html`] = legalPage(slug);
for (const [name, html] of Object.entries(pages)) {
  await mkdir(new URL('./', new URL(name, target)), { recursive: true });
  await writeFile(new URL(name, target), html.replaceAll('info@jinhefilm.com', email));
}
const media = JSON.parse(await readFile(new URL('web/media.json', root), 'utf8'));
const assets = ['site.css', 'purchase.css', 'assets/studio.webp', 'assets/display.woff2', 'assets/FONT-LICENSE.txt', 'media.json', 'release.json', ...media.files.map(file => file.path)];
if (new Set(assets).size !== assets.length || assets.some(path => !/^(?:[a-z0-9-]+\.(?:css|json)|(?:assets|media)\/[a-zA-Z0-9.-]+\.(?:webp|woff2|txt|mp4|vtt))$/.test(path))) throw new Error('网站素材路径无效或重复');
for (const name of assets) {
  await mkdir(new URL('./', new URL(name, target)), { recursive: true });
  await copyFile(new URL(`web/${name}`, root), new URL(name, target));
}
for (const file of media.files) {
  const bytes = await readFile(new URL(file.path, target));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`素材校验失败：${file.path}`);
}
await writeFile(new URL('robots.txt', target), 'User-agent: *\nAllow: /\nDisallow: /purchase/\nSitemap: https://tuanbo-link.jinhefilm.com/sitemap.xml\n');
await writeFile(new URL('sitemap.xml', target), `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/download/', '/guide/', ...LEGAL_PAGES.map(slug => `/${slug}/`)].map(path => `<url><loc>https://tuanbo-link.jinhefilm.com${path}</loc></url>`).join('')}</urlset>`);
const names = [...Object.keys(pages), 'site.js', 'purchase.js', ...assets, 'robots.txt', 'sitemap.xml'].sort();
const files = {};
for (const name of names) { const bytes = await readFile(new URL(name, target)); files[name] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
await writeFile(new URL('website-manifest.json', target), JSON.stringify({ version: 1, files }, null, 2));
console.log(`官网构建完成：${Object.keys(pages).length} 个页面，${names.length} 个已校验文件。`);
