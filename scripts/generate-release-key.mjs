// Creates one Ed25519 release-signing key. The private key goes to a new file only (never printed); the
// public key is printed for apps/desktop/src/main/link/release-public-keys.json under its kid.
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [path, kid] = process.argv.slice(2);
if (!path || !kid || !/^release-\d{4}-\d{2}-[a-z]$/.test(kid)) throw new Error('用法：node scripts/generate-release-key.mjs <私钥文件路径> release-YYYY-MM-x');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
// flag wx: never replace an existing key.
await writeFile(resolve(path), privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ [kid]: publicKey.export({ type: 'spki', format: 'pem' }).toString() }));
