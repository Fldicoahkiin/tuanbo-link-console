import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const target = new URL('dist/web/', root);
await mkdir(target, { recursive: true });
await build({ entryPoints: [new URL('web/main.ts', root).pathname], outfile: new URL('purchase.js', target).pathname,
  bundle: true, platform: 'browser', target: 'es2022', format: 'esm', minify: true });
const email = process.env.TBLINK_CONTACT_EMAIL ?? 'info@jinhefilm.com';
if (!/^[a-z0-9][a-z0-9._+-]*@jinhefilm\.com$/.test(email) || email.startsWith('admin@')) throw new Error('联系邮箱须为非 admin 的 jinhefilm.com 邮箱');
const videoPath = process.env.TBLINK_DEMO_VIDEO_PATH;
if (videoPath !== undefined && !/^\/media\/[a-z0-9][a-z0-9-]*\.mp4$/.test(videoPath)) throw new Error('演示视频须为同源 /media/ 下的 MP4 文件');
const demo = videoPath
  ? `<video controls playsinline preload="none" aria-label="团播联动台操作演示"><source src="${videoPath}" type="video/mp4">浏览器无法播放此视频，请联系支持获取演示。</video><p class="hint">如无法播放，请检查网络或联系支持。</p>`
  : '<div class="demo-empty"><strong>演示视频准备中</strong><p>录制完成后会在这里展示实际操作。购买前如需了解功能，请联系下方邮箱。</p></div>';
const html = (await readFile(new URL('web/index.html', root), 'utf8')).replace('<!-- DEMO_VIDEO -->', demo).replaceAll('info@jinhefilm.com', email);
await writeFile(new URL('index.html', target), html);
await copyFile(new URL('web/purchase.css', root), new URL('purchase.css', target));
