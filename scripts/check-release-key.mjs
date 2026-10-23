// Checks that a release-signing private key file (for example the offline backup on a USB drive) can be read
// and is one of the keys the client embeds. Prints only the kid; never the key.
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function checkKey(path) {
  if (!path) throw new Error('用法：node scripts/check-release-key.mjs <私钥文件路径>');
  const privateKey = createPrivateKey(readFileSync(path));
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const embedded = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../apps/desktop/src/main/link/release-public-keys.json'), 'utf8'));
  const kid = Object.keys(embedded).find(id => embedded[id].trim() === publicPem.trim());
  if (!kid) throw new Error('这把私钥不是客户端内置的任何一把发布密钥');
  const sample = randomBytes(64);
  if (!verify(null, sample, createPublicKey(embedded[kid]), sign(null, sample, privateKey))) throw new Error('私钥签名后无法用内置公钥验证');
  console.log(`备份可用：这把私钥对应客户端内置的 ${kid}，签名和验签都正常。`);
}

// The user runs this by hand: one readable line instead of a stack trace (wrong drive letter, wrong file).
try {
  checkKey(process.argv[2]);
} catch (error) {
  console.error(`检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
