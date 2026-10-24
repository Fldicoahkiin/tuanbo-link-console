// Sends the signed release in apps/desktop/dist to the server's staging area through the restricted
// tblink-release SSH identity (apps/licensing-server/deploy/receive-update.py). It cannot write the feed: the
// server's publisher validates the staged release again and publishes it once it passes.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const key = process.env.TBLINK_RELEASE_UPLOAD_KEY;
const knownHosts = process.env.TBLINK_RELEASE_KNOWN_HOSTS;
if (!key || !knownHosts) throw new Error('需要 TBLINK_RELEASE_UPLOAD_KEY 与 TBLINK_RELEASE_KNOWN_HOSTS');
// Windows' own ssh.exe (OpenSSH_for_Windows 9.5) stops sending a large redirected stdin after about 100 KB, from a
// pipe or a file alike; the builder names Git for Windows' ssh.exe, which sends it through.
const ssh = process.env.TBLINK_RELEASE_SSH ?? (process.platform === 'win32' ? null : 'ssh');
if (!ssh) throw new Error('Windows 上要用 TBLINK_RELEASE_SSH 指定 Git for Windows 的 ssh.exe：系统自带的 ssh.exe 发送大量输入会停住');
const dist = join(process.cwd(), 'apps/desktop/dist');
const manifestBytes = readFileSync(join(dist, 'release-manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
if (!manifest.releaseSignature) throw new Error('未签名的候选包只能用于安装验收，不能上传到发布 staging');
const installer = `Tuanbo-Link-Console-${manifest.version}-x64.exe`;
const files = ['release-manifest.json', 'latest.yml', installer, `${installer}.blockmap`];

// The archive is written to disk first and handed to ssh as its stdin file, the way the 0.5.0 upload went through.
const archive = join(dist, 'upload.tar');
const tar = spawnSync('tar', ['-cf', archive, '-C', dist, ...files], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
if (tar.status !== 0) throw new Error(`打包上传内容失败（tar 退出码 ${tar.status}）：${(tar.stderr ?? String(tar.error)).slice(-2000)}`);
const input = openSync(archive, 'r');
const upload = spawn(ssh, ['-F', 'none', '-T', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
  '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
  'tblink-release@123.206.229.200'], { stdio: [input, 'pipe', 'pipe'], windowsHide: true });
const output = { stdout: '', stderr: '' };
upload.stdout.on('data', chunk => { output.stdout += chunk; });
upload.stderr.on('data', chunk => { output.stderr += chunk; });
// The receiver allows an hour; give up a little later rather than hang the release job.
const timer = setTimeout(() => { upload.kill(); }, 65 * 60 * 1000);
const sshCode = await new Promise(resolve => upload.once('close', resolve));
clearTimeout(timer);
closeSync(input);
if (sshCode !== 0) throw new Error(`服务器拒绝或上传中断（ssh 退出码 ${sshCode}）：${output.stderr.slice(-2000)}`);
const result = JSON.parse(output.stdout);
if (result.manifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex')) throw new Error('服务器收到的 manifest 与本次构建不一致');
console.log(`已上传到发布 staging：${result.staged}（${result.bytes} 字节）。服务器校验通过后会自动发布。`);
