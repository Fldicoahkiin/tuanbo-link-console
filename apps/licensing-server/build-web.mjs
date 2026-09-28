import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('./', import.meta.url);
const target = new URL('dist/web/', root);
await mkdir(target, { recursive: true });
await build({ entryPoints: [new URL('web/main.ts', root).pathname], outfile: new URL('purchase.js', target).pathname,
  bundle: true, platform: 'browser', target: 'es2022', format: 'esm', minify: true });
await Promise.all(['index.html', 'purchase.css'].map(file => copyFile(new URL(`web/${file}`, root), new URL(file, target))));
