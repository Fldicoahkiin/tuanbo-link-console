import { chromium } from '../apps/desktop/node_modules/@playwright/test/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Render the vector master at each native size instead of scaling a small bitmap.
const directory = new URL('../apps/desktop/build/', import.meta.url);
const svg = await readFile(new URL('icon.svg', directory), 'utf8');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const images = new Map();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    images.set(size, await page.screenshot({ omitBackground: true }));
  }
} finally { await browser.close(); }

await writeFile(new URL('icon.png', directory), images.get(1024));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const image = images.get(size);
  const entry = 6 + index * 16;
  header[entry] = header[entry + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
});
await writeFile(new URL('icon.ico', directory), Buffer.concat([header, ...sizes.map(size => images.get(size))]));

const chunks = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, size]) => {
  const image = images.get(size);
  const chunk = Buffer.alloc(8);
  chunk.write(type, 0, 4, 'ascii');
  chunk.writeUInt32BE(image.length + 8, 4);
  return Buffer.concat([chunk, image]);
});
const icns = Buffer.alloc(8);
icns.write('icns');
icns.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4);
await writeFile(new URL('icon.icns', directory), Buffer.concat([icns, ...chunks]));
console.log(`Exported PNG, multi-size ICO and ICNS: ${fileURLToPath(directory)}`);
