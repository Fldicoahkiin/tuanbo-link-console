import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
const root = resolve('apps/licensing-server/dist/web');
const manifest = JSON.parse(await readFile(join(root, 'website-manifest.json'), 'utf8'));
const files = new Set([...Object.keys(manifest.files), 'website-manifest.json']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', csp); res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'PREVIEW_ONLY', message: '本地预览不创建订单。购买请访问正式官网。' })); return; }
    if (path === '/v1/catalog') {
      const response = await fetch('https://tuanbo-link.jinhefilm.com/v1/catalog', { signal: AbortSignal.timeout(12000), headers: { 'X-Tblink-Payment-Channel': req.headers['x-tblink-payment-channel'] === 'wechat' ? 'wechat' : 'alipay' } });
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'X-Tblink-Payment-Channel': response.headers.get('X-Tblink-Payment-Channel') ?? 'alipay' }).end(await response.text()); return;
    }
    const file = path.slice(1) + (path.endsWith('/') ? 'index.html' : '');
    if (!files.has(file)) { res.writeHead(404).end('Not found'); return; }
    const data = await readFile(join(root, file));
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream'); res.setHeader('Accept-Ranges', 'bytes');
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      const start = match ? Number(match[1]) : NaN, end = match?.[2] ? Number(match[2]) : data.length - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= data.length) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end(); return; }
      const last = Math.min(end, data.length - 1); res.writeHead(206, { 'Content-Range': `bytes ${start}-${last}/${data.length}`, 'Content-Length': last - start + 1 }); res.end(req.method === 'HEAD' ? undefined : data.subarray(start, last + 1)); return;
    }
    res.writeHead(200, { 'Content-Length': data.length }); res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) { console.error(error.message); if (!res.headersSent) res.writeHead(502); res.end('Preview request failed'); }
});
server.listen(Number(process.env.TBLINK_WEBSITE_PORT ?? 4178), '127.0.0.1', () => console.log(`官网预览：http://127.0.0.1:${server.address().port}/（不创建生产订单）`));
