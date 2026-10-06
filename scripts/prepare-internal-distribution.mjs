// Generate a one-build, machine-bound grant. The private key never leaves this process.
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('内测签发必须在目标 Windows 主机执行');
const destination = resolve(process.argv[2] ?? 'artifacts/internal-distribution');
const output = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
const guid = /MachineGuid\s+REG_SZ\s+([a-f0-9-]{32,36})/i.exec(output)?.[1];
if (!guid) throw new Error('未能取得本机标识');
const machineCode = `TB1-${createHash('sha256').update(`tuanbo-link-console:machine:v1:${guid.toLowerCase()}`).digest('hex').toUpperCase()}`;
const keys = generateKeyPairSync('ed25519');
const kid = `internal-${randomUUID()}`;
const now = new Date(), end = new Date(now.getTime() + 14 * 86400000);
const claims = { version: 1, product: 'tuanbo-link-console', licenseId: randomUUID(), customer: '灯光模块本机内测', machineCode, kind: 'subscription', issuedAt: now.toISOString(), useUntil: end.toISOString(), updatesUntil: end.toISOString() };
const body = `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
const token = `${body}.${sign(null, Buffer.from(body), keys.privateKey).toString('base64url')}`;
await mkdir(destination, { recursive: true });
await writeFile(resolve(destination, 'distribution.json'), JSON.stringify({ channel: 'internal', publicKeys: { [kid]: keys.publicKey.export({ type: 'spki', format: 'pem' }) }, token }, null, 2), { flag: 'wx' });
console.log(`已生成独立内测签名许可，有效至 ${end.toISOString()}；私钥未落盘。`);
