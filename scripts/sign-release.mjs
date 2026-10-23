// Signs apps/desktop/dist/latest.yml with the release key, after `pnpm dist` and before the release manifest.
// TBLINK_RELEASE_SIGNING_KEY_FILE (private key PEM) and TBLINK_RELEASE_SIGNING_KID come from the release
// builder. Without them the build stays unsigned: such a candidate is for install acceptance only, and the
// server refuses to publish it.
import { createPrivateKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { signUpdateMetadata, validateReleaseVersion } from './release-config.mjs';

const root = process.cwd();
const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
const version = validateReleaseVersion(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')), desktopPackage);
const keyFile = process.env.TBLINK_RELEASE_SIGNING_KEY_FILE;
const kid = process.env.TBLINK_RELEASE_SIGNING_KID;
if (!keyFile && !kid) {
  console.log('未配置发布签名密钥：本次候选包未签名，只能用于安装验收，不能发布到更新源');
  process.exit(0);
}
if (!keyFile || !kid) throw new Error('TBLINK_RELEASE_SIGNING_KEY_FILE 与 TBLINK_RELEASE_SIGNING_KID 必须同时提供');
const distDirectory = join(root, process.env.TBLINK_DIST_DIRECTORY ?? 'apps/desktop/dist');
const installerName = `Tuanbo-Link-Console-${version}-x64.exe`;
const feed = join(distDirectory, 'latest.yml');
const publicKeys = JSON.parse(readFileSync(join(root, 'apps/desktop/src/main/link/release-public-keys.json'), 'utf8'));
writeFileSync(feed, signUpdateMetadata(readFileSync(feed, 'utf8'), {
  installerName, installerBytes: readFileSync(join(distDirectory, installerName)),
  privateKey: createPrivateKey(readFileSync(keyFile)), kid, publicKeys
}));
console.log(`latest.yml 已用 ${kid} 签名：${installerName}`);
