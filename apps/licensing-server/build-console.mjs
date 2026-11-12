import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const output = new URL('dist/console/', root);
await mkdir(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL('console/main.tsx', root))], outfile: fileURLToPath(new URL('console.js', output)), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
// 样式：Tailwind 扫 console/ 下用到的类，把 console/styles.css 编成一个 console.css。线上的 CSP 是 style-src 'self'，所以样式只能在这一个文件里，页面运行时不插 <style>。
const styles = 'console/styles.css';
const tailwind = join(dirname(createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs');
try { execFileSync(process.execPath, [tailwind, '--input', fileURLToPath(new URL(styles, root)), '--output', fileURLToPath(new URL('console.css', output)), '--minify'], { cwd: fileURLToPath(root), stdio: 'pipe' }); }
catch (error) { throw new Error(`Tailwind 编译 ${styles} 失败：${error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error)}`, { cause: error }); }
await copyFile(new URL('console/index.html', root), new URL('index.html', output));
const files = {};
for (const name of ['index.html', 'console.js', 'console.css']) files[name] = createHash('sha256').update(await readFile(new URL(name, output))).digest('hex');
await writeFile(new URL('manifest.json', output), JSON.stringify({ version: 1, files }, null, 2));
await build({ entryPoints: [fileURLToPath(new URL('src/console-bootstrap.ts', root))], outfile: fileURLToPath(new URL('dist/console-bootstrap.js', root)), bundle: true, platform: 'node', target: 'node22', format: 'esm' });
