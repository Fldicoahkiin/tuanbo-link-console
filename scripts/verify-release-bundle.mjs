// After `electron-vite build --mode release`: the bundle must not carry the local test access that packaging refuses
// (apps/desktop/scripts/require-release-build.mjs). Verify Desktop runs this on every master push, so a leak shows up
// minutes after the change instead of half an hour into a release build.
import { readFileSync } from 'node:fs';
import { developmentAccessIn } from './release-config.mjs';

const bundles = ['apps/desktop/out/main/index.cjs', 'apps/desktop/out/preload/index.cjs'];
const found = bundles.flatMap(path => developmentAccessIn(readFileSync(path)).map(marker => `${path} 含有 ${marker}`));
if (found.length > 0) throw new Error(`正式模式构建带了本机开发测试通道，打包会被拒绝：${found.join('；')}`);
console.log(`正式模式构建不含本机开发测试通道：${bundles.join('、')}`);
