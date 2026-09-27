import { readFileSync } from 'node:fs';
import { validateReleaseVersion } from './release-config.mjs';

const args = process.argv.slice(2);
if (args.length > 1) throw new Error('用法：node scripts/verify-release-version.mjs [vX.Y.Z]');
const rootPackage = JSON.parse(readFileSync('package.json', 'utf8'));
const desktopPackage = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'));
const version = validateReleaseVersion(rootPackage, desktopPackage, args[0]);
console.log(`版本一致：${version}${args[0] ? `，标签：${args[0]}` : ''}`);
