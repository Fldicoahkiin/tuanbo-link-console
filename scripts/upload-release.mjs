// Sends the signed release in apps/desktop/dist to the server's staging area through the restricted
// tblink-release SSH identity (apps/licensing-server/deploy/receive-update.py). It cannot publish:
// the owner confirms the staged release in the console, and the server validates it again.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const key = process.env.TBLINK_RELEASE_UPLOAD_KEY;
const knownHosts = process.env.TBLINK_RELEASE_KNOWN_HOSTS;
if (!key || !knownHosts) throw new Error('需要 TBLINK_RELEASE_UPLOAD_KEY 与 TBLINK_RELEASE_KNOWN_HOSTS');
const dist = join(process.cwd(), 'apps/desktop/dist');
const manifestBytes = readFileSync(join(dist, 'release-manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (!manifest.releaseSignature) throw new Error('未签名的候选包只能用于安装验收，不能上传到发布 staging');
const installer = `Tuanbo-Link-Console-${manifest.version}-x64.exe`;
const files = ['release-manifest.json', 'latest.yml', installer, `${installer}.blockmap`];

const tar = spawn('tar', ['-cf', '-', '-C', dist, ...files], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const ssh = spawn('ssh', ['-F', 'none', '-T', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
  'tblink-release@123.206.229.200'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
tar.stdout.pipe(ssh.stdin);
const output = { tar: '', stdout: '', stderr: '' };
tar.stderr.on('data', chunk => { output.tar += chunk; });
ssh.stdout.on('data', chunk => { output.stdout += chunk; });
ssh.stderr.on('data', chunk => { output.stderr += chunk; });
// The receiver allows an hour; give up a little later rather than hang the release job.
const timer = setTimeout(() => { tar.kill(); ssh.kill(); }, 65 * 60 * 1000);
const [tarCode, sshCode] = await Promise.all([new Promise(resolve => tar.once('close', resolve)), new Promise(resolve => ssh.once('close', resolve))]);
clearTimeout(timer);
if (tarCode !== 0) throw new Error(`打包上传内容失败（tar 退出码 ${tarCode}）：${output.tar.slice(-2000)}`);
if (sshCode !== 0) throw new Error(`服务器拒绝或上传中断（ssh 退出码 ${sshCode}）：${output.stderr.slice(-2000)}`);
const result = JSON.parse(output.stdout);
if (result.manifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex')) throw new Error('服务器收到的 manifest 与本次构建不一致');
console.log(`已上传到发布 staging：${result.staged}（${result.bytes} 字节）。到运营后台「软件更新」确认发布。`);
