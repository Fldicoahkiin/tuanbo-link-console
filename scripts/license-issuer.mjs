// Run only on the publisher's machine. Never bundle private keys with the app.
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [command, ...args] = process.argv.slice(2);
function required(name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`缺少 --${name}`);
  return args[index + 1];
}
async function writeNew(path, content) { await writeFile(resolve(path), content, { flag: 'wx', mode: 0o600 }); }
try {
  if (command === 'keygen') {
    const privatePath = required('private');
    const publicPath = required('public');
    const kid = required('kid');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(kid)) throw new Error('kid 只允许字母、数字、下划线和短横线');
    const keys = generateKeyPairSync('ed25519');
    await writeNew(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeNew(publicPath, JSON.stringify({ [kid]: keys.publicKey.export({ type: 'spki', format: 'pem' }) }, null, 2));
    console.log('签发密钥已生成。私钥仅供发行方保管；只有公钥 JSON 可放入客户端。');
  } else if (command === 'issue') {
    const request = JSON.parse(await readFile(resolve(required('request')), 'utf8'));
    if (request.version !== 1 || request.product !== 'tuanbo-link-console' || !/^TB1-[A-F0-9]{64}$/.test(request.machineCode)) throw new Error('授权申请格式无效');
    const kind = required('kind');
    if (!['perpetual', 'subscription', 'trial'].includes(kind)) throw new Error('kind 必须为 perpetual、subscription 或 trial');
    const customer = required('customer').trim();
    if (!customer || customer.length > 160) throw new Error('客户名称长度必须在 1 至 160 字之间');
    const now = new Date();
    const useUntil = kind === 'perpetual' ? null : new Date(required('use-until'));
    const updatesUntil = new Date(required('updates-until'));
    if (!Number.isFinite(updatesUntil.getTime()) || updatesUntil <= now || useUntil && (!Number.isFinite(useUntil.getTime()) || useUntil <= now)) throw new Error('期限必须为未来的有效 ISO 日期');
    const privateKey = createPrivateKey(await readFile(resolve(required('private')), 'utf8'));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('签发私钥必须为 Ed25519');
    const kid = required('kid');
    const trusted = JSON.parse(await readFile(resolve(required('public')), 'utf8'));
    if (!Object.hasOwn(trusted, kid) || createPublicKey(trusted[kid]).export({ type: 'spki', format: 'pem' }) !== createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })) throw new Error('签发私钥与选定的公钥不匹配');
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid })).toString('base64url');
    const claims = { version: 1, product: 'tuanbo-link-console', licenseId: randomUUID(), customer, machineCode: request.machineCode, kind, issuedAt: now.toISOString(), useUntil: useUntil?.toISOString() ?? null, updatesUntil: updatesUntil.toISOString() };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const input = `${header}.${body}`;
    await writeNew(required('out'), `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`);
    console.log(`已签发 ${kind} 单主机授权，编号 ${claims.licenseId}。请在订单台账登记该编号。`);
  } else {
    throw new Error('用法：keygen --kid ID --private 私钥路径 --public 公钥JSON路径；issue --private 私钥路径 --public 公钥JSON路径 --kid ID --request 申请JSON --customer 客户 --kind perpetual|subscription|trial --updates-until ISO日期 [--use-until ISO日期] --out 授权.tbllicense');
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
