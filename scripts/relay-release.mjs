// Carries a release the cloud build left as a draft GitHub release to the server, and publishes the GitHub release
// once the update feed serves it. Every run checks the state again and does the next step, so it can run on a
// schedule (the office PC's task, every 10 minutes) or by hand (a Mac: pnpm release:relay), on several machines at
// once, and a failed step is just tried again on the next run:
//   1. The highest complete draft vX.Y.Z at or above the feed's version is the one to carry; lower ones are logged.
//   2. Feed already serves it, byte for byte: publish the draft, marked Latest.
//   3. Otherwise ask the server (tblink-release `status`): already staged, or another upload running: wait.
//   4. Otherwise download the draft, check it against its manifest and the tag's commit, upload it, and wait up to
//      ten minutes for the server to publish it so a run by hand finishes the whole job. When the server can rebuild
//      the installer (its `status` names DELTA_FORMAT), only the blocks the feed's installer lacks are downloaded and
//      sent, about 1% of it; the server checks the rebuilt file against the manifest as it checks a full upload. If
//      that fails, the same run downloads and sends the full installer.
// node --use-env-proxy scripts/relay-release.mjs [--log <directory>]   (GitHub through HTTPS_PROXY; the server direct)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { REPOSITORY, downloadAsset, downloadAssetRange, github } from './github-releases.mjs';

// Must equal apps/desktop/package.json build.publish.url (checked by relay-release.test.mjs); the office PC runs this
// file outside a checkout.
export const FEED_URL = 'https://updates.tuanbo-link.jinhefilm.com/windows/x64/';
const LOG_DAYS = 14;
const windows = process.platform === 'win32';
// The office PC keeps its upload key where the release builder had it and reaches the server's public address; a Mac
// uses its own key and the server's Tailscale address, which its existing known_hosts already lists.
const config = {
  key: process.env.TBLINK_RELEASE_UPLOAD_KEY ?? (windows ? 'D:/tblink-release-signing/upload/tblink-release-ed25519' : join(homedir(), '.config/tblink-remote/tblink_release_upload')),
  knownHosts: process.env.TBLINK_RELEASE_KNOWN_HOSTS ?? (windows ? 'D:/tblink-release-signing/upload/known_hosts' : join(homedir(), '.config/tblink-remote/known_hosts')),
  host: process.env.TBLINK_RELEASE_HOST ?? (windows ? '123.206.229.200' : '100.111.120.96'),
  // Windows' own ssh.exe stops sending a large stdin after about 100 KB; Git for Windows' sends it through.
  ssh: process.env.TBLINK_RELEASE_SSH ?? (windows ? 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe' : 'ssh'),
  cache: process.env.TBLINK_RELAY_CACHE ?? (windows ? 'D:/tblink-relay/cache' : join(tmpdir(), 'tblink-relay'))
};

const stableVersion = /^v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;
export function compareVersions(left, right) {
  const a = left.split('.').map(Number); const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
const installerOf = version => `Tuanbo-Link-Console-${version}-x64.exe`;
const filesOf = version => ['release-manifest.json', 'latest.yml', installerOf(version), `${installerOf(version)}.blockmap`];
const deltaFilesOf = version => ['release-manifest.json', 'latest.yml', `${installerOf(version)}.blockmap`, `${installerOf(version)}.delta`];

// Must equal DELTA_FORMAT in apps/licensing-server/deploy/receive-update.py. A delta is one JSON line, then the bytes
// the base lacks: {"format", "base": {"file", "size"}, "size", "ops"}, where [0, start, length] copies from the base
// installer on the feed and [1, length] takes the next bytes after the line.
export const DELTA_FORMAT = 'tblink-installer-delta-1';

/** The blocks of an electron-builder blockmap: gzipped JSON with one file that starts at offset 0. */
export function readBlockmap(bytes) {
  const files = JSON.parse(gunzipSync(bytes).toString('utf8')).files;
  const blocks = files?.length === 1 ? files[0] : null;
  if (!blocks || blocks.offset !== 0 || !Array.isArray(blocks.checksums) || !Array.isArray(blocks.sizes) || blocks.checksums.length !== blocks.sizes.length
    || !blocks.sizes.every(size => Number.isSafeInteger(size) && size > 0)) throw new Error('blockmap 的格式不是一个从头开始的文件');
  return { checksums: blocks.checksums, sizes: blocks.sizes, size: blocks.sizes.reduce((sum, size) => sum + size, 0) };
}

/** How to build the new installer from the old one, matching electron-updater's own plan (downloadPlanBuilder.js):
 * a block whose checksum and size are in the old map is copied from its first place there, any other block is sent.
 * Neighbouring copies and sends are merged. */
export function deltaPlan(oldMap, newMap) {
  const old = new Map();
  for (let index = 0, offset = 0; index < oldMap.checksums.length; offset += oldMap.sizes[index], index += 1) {
    if (!old.has(oldMap.checksums[index])) old.set(oldMap.checksums[index], { offset, size: oldMap.sizes[index] });
  }
  const ops = []; const sent = [];
  for (let index = 0, offset = 0; index < newMap.checksums.length; offset += newMap.sizes[index], index += 1) {
    const size = newMap.sizes[index]; const match = old.get(newMap.checksums[index]); const last = ops.at(-1);
    if (match?.size === size) {
      if (last?.[0] === 0 && last[1] + last[2] === match.offset) last[2] += size;
      else ops.push([0, match.offset, size]);
    } else if (last?.[0] === 1) {
      last[1] += size; sent.at(-1).length += size;
    } else {
      ops.push([1, size]); sent.push({ start: offset, length: size });
    }
  }
  return { ops, sent, bytes: sent.reduce((sum, range) => sum + range.length, 0) };
}

/** Writes the delta: the JSON line, then the sent ranges of the new installer, which `read(start, length)` returns
 * (at most 8 MiB at a time). */
export async function writeDelta({ plan, base, size, read, output }) {
  const target = await open(output, 'w');
  try {
    await target.write(`${JSON.stringify({ format: DELTA_FORMAT, base, size, ops: plan.ops })}\n`);
    for (const { start, length } of plan.sent) {
      for (let done = 0; done < length;) {
        const piece = Math.min(8 * 1024 * 1024, length - done);
        const bytes = await read(start + done, piece);
        if (bytes.length !== piece) throw new Error(`安装包第 ${start + done} 字节起只读到 ${bytes.length} 字节，应为 ${piece}`);
        await target.write(bytes);
        done += piece;
      }
    }
  } finally {
    await target.close();
  }
}

const uploadedFiles = release => filesOf(release.tag_name.slice(1)).filter(name => release.assets.some(asset => asset.name === name && asset.state === 'uploaded')).length;
const versionDrafts = releases => releases.filter(release => release.draft && stableVersion.test(release.tag_name));

/** Complete drafts (all four files uploaded), highest version first. */
export function pendingDrafts(releases) {
  return versionDrafts(releases)
    .filter(release => uploadedFiles(release) === 4)
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)));
}

/** Drafts whose files are not all there: a build still uploading, or one that failed, like v0.5.1. Never carried. */
export function incompleteDrafts(releases) {
  return versionDrafts(releases).filter(release => uploadedFiles(release) < 4).map(release => ({ tag: release.tag_name, files: uploadedFiles(release) }));
}

let logFile = null;
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

function openLog(directory) {
  mkdirSync(directory, { recursive: true });
  logFile = join(directory, `relay-${new Date().toISOString().slice(0, 10)}.log`);
  const cutoff = Date.now() - LOG_DAYS * 86_400_000;
  for (const name of readdirSync(directory)) {
    if (/^relay-\d{4}-\d{2}-\d{2}\.log$/.test(name) && statSync(join(directory, name)).mtimeMs < cutoff) rmSync(join(directory, name));
  }
}

function sshArguments(command) {
  return ['-F', 'none', '-T', '-i', config.key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${config.knownHosts}`, '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
    `tblink-release@${config.host}`, ...command];
}

function serverStatus() {
  const result = spawnSync(config.ssh, sshArguments(['status']), { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`读取服务器 staging 状态失败（ssh 退出码 ${result.status}）：${(result.stderr || String(result.error)).trim().slice(-500)}`);
  return JSON.parse(result.stdout);
}

async function readFeed() {
  const response = await fetch(new URL('latest.yml', FEED_URL), { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`读取更新源失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const version = /^version: (.+)$/m.exec(bytes.toString('utf8'))?.[1];
  if (!version) throw new Error('更新源的 latest.yml 没有版本号');
  return { bytes, version };
}

async function tagCommit(tag) {
  const ref = await github(`/repos/${REPOSITORY}/git/ref/tags/${tag}`);
  return ref.object.type === 'tag' ? (await github(`/repos/${REPOSITORY}/git/tags/${ref.object.sha}`)).object.sha : ref.object.sha;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** The draft's latest.yml, which must be the bytes the feed serves once the server has published it. */
async function draftFeed(draft, directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'latest.yml.draft');
  await downloadAsset(draft.assets.find(asset => asset.name === 'latest.yml'), path);
  return readFile(path);
}

async function publishDraft(draft) {
  const published = await github(`/repos/${REPOSITORY}/releases/${draft.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'true' } });
  log(`${draft.tag_name} 已在更新源上线，GitHub release 已转为正式并标为 Latest：${published.html_url}`);
  return `${draft.tag_name} 已上线，GitHub release 已转为正式`;
}

/** Downloads (or reuses) the draft's files into the cache and checks them against the manifest and the tag's commit.
 * Without the installer, only the manifest, latest.yml and the blockmap. */
async function fetchDraft(draft, version, commit, directory, { installer = true } = {}) {
  mkdirSync(config.cache, { recursive: true });
  // Only this release's files are kept: a run after a failed upload reuses them, older releases' are dropped.
  for (const entry of readdirSync(config.cache)) if (join(config.cache, entry) !== directory) rmSync(join(config.cache, entry), { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const asset = name => draft.assets.find(item => item.name === name);
  await downloadAsset(asset('release-manifest.json'), join(directory, 'release-manifest.json'));
  const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== version || manifest.gitSha !== commit || manifest.gitWorkingTreeDirty !== false || manifest.summary?.checksFailed !== 0 || !manifest.releaseSignature) {
    throw new Error(`${draft.tag_name} 的构建清单与标签提交 ${commit} 或检查结果不符`);
  }
  for (const name of filesOf(version).slice(1).filter(name => installer || name !== installerOf(version))) {
    const records = manifest.artifacts.filter(item => item.path === `apps/desktop/dist/${name}`);
    if (records.length !== 1) throw new Error(`构建清单里没有唯一的 ${name}`);
    const path = join(directory, name);
    if (existsSync(path) && statSync(path).size === records[0].bytes && await sha256(path) === records[0].sha256) continue;
    const { sha256: digest, size } = await downloadAsset(asset(name), path);
    if (digest !== records[0].sha256 || size !== records[0].bytes) throw new Error(`${name} 与构建清单不一致`);
    log(`已下载 ${name}（${size} 字节）`);
  }
  return readFile(join(directory, 'release-manifest.json'));
}

/** Sends the files as one tar on ssh's stdin. Returns the receiver's reply: its result, or its error line. */
async function send(directory, files) {
  const archive = join(directory, 'upload.tar');
  // macOS tar adds a "._name" entry for every file with extended attributes (downloads carry com.apple.provenance),
  // and the server accepts exactly the four release files. COPYFILE_DISABLE=1 leaves those entries out; other tars
  // ignore it.
  const tar = spawnSync('tar', ['-cf', archive, '-C', directory, ...files], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000, env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (tar.status !== 0) throw new Error(`打包上传内容失败（tar 退出码 ${tar.status}）：${(tar.stderr || String(tar.error)).slice(-500)}`);
  const input = openSync(archive, 'r');
  const started = Date.now();
  try {
    // The archive is ssh's stdin file: a pipe stalls Windows' own ssh.exe, a file goes through either ssh.
    const child = spawn(config.ssh, sshArguments([]), { stdio: [input, 'pipe', 'pipe'], windowsHide: true });
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', chunk => { output.stdout += chunk; });
    child.stderr.on('data', chunk => { output.stderr += chunk; });
    // The receiver allows an hour; give up a little later.
    const timer = setTimeout(() => child.kill(), 65 * 60_000);
    const code = await new Promise(resolve => child.once('close', resolve));
    clearTimeout(timer);
    if (code === 0) return { result: JSON.parse(output.stdout), seconds: (Date.now() - started) / 1000 };
    const reply = output.stderr.trim().split('\n').at(-1) ?? '';
    return { failure: `服务器拒绝或上传中断（ssh 退出码 ${code}）：${output.stderr.trim().slice(-500)}`, retryFull: reply.startsWith('{') && JSON.parse(reply).retryFull === true };
  } finally {
    closeSync(input);
  }
}

/** Writes the delta against the feed's installer into the release's directory, downloading only the blocks the feed's
 * installer lacks from the draft, or says why it cannot. */
async function prepareDelta(draft, version, directory, manifestBytes, feed) {
  const base = installerOf(feed.version);
  const size = Number(/^ {4}size: (\d+)$/m.exec(feed.bytes.toString('utf8'))?.[1]);
  const response = await fetch(new URL(`${base}.blockmap`, FEED_URL), { cache: 'no-store', signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok) throw new Error(`读取更新源上 ${base}.blockmap 失败：HTTP ${response.status}`);
  const oldMap = readBlockmap(Buffer.from(await response.arrayBuffer()));
  if (oldMap.size !== size) throw new Error(`更新源上 ${feed.version} 的 blockmap 与 latest.yml 记的大小不一致`);
  const installer = installerOf(version);
  const record = JSON.parse(manifestBytes.toString('utf8')).artifacts.find(item => item.path === `apps/desktop/dist/${installer}`);
  const asset = draft.assets.find(item => item.name === installer);
  const newMap = readBlockmap(await readFile(join(directory, `${installer}.blockmap`)));
  if (newMap.size !== record?.bytes || newMap.size !== asset?.size) throw new Error(`${installer} 与它的 blockmap、构建清单大小不一致`);
  const plan = deltaPlan(oldMap, newMap);
  const started = Date.now();
  await writeDelta({ plan, base: { file: base, size }, size: newMap.size, read: (start, length) => downloadAssetRange(asset, start, length), output: join(directory, `${installer}.delta`) });
  log(`只下载、上传变化的部分：${plan.bytes} 字节，完整安装包 ${newMap.size} 字节（${(plan.bytes / newMap.size * 100).toFixed(2)}%），${plan.sent.length} 段，下载用了 ${((Date.now() - started) / 1000).toFixed(0)} 秒；服务器以更新源上的 ${feed.version} 为底拼出新包`);
}

/** Uploads the release: only the changed blocks when the server can rebuild the installer, otherwise (or when that
 * fails) the full installer, downloaded first. */
async function upload(draft, version, commit, directory, { server, feed }) {
  let manifestBytes = await fetchDraft(draft, version, commit, directory, { installer: server.delta !== DELTA_FORMAT });
  let reply = null;
  if (server.delta === DELTA_FORMAT) {
    const ready = await prepareDelta(draft, version, directory, manifestBytes, feed).then(() => true, error => {
      log(`不能只传变化的部分，改传完整安装包：${error.message}`);
      return false;
    });
    if (ready) {
      reply = await send(directory, deltaFilesOf(version));
      if (reply.failure && reply.retryFull) {
        log(`服务器没能用变化的部分拼出新包，改传完整安装包：${reply.failure}`);
        reply = null;
      }
    }
    if (!reply) manifestBytes = await fetchDraft(draft, version, commit, directory);
  }
  reply ??= await send(directory, filesOf(version));
  if (reply.failure) throw new Error(reply.failure);
  const { result, seconds } = reply;
  if (result.manifestSha256 !== createHash('sha256').update(manifestBytes).digest('hex')) throw new Error('服务器收到的 manifest 与草稿不一致');
  log(`已上传到 staging：${result.staged}，${result.bytes} 字节，${seconds.toFixed(0)} 秒（${(result.bytes / 1024 / seconds).toFixed(0)} KB/s）${result.rebuiltFrom ? `，服务器用 ${result.rebuiltFrom} 拼出了完整安装包` : ''}`);
}

async function relay() {
  const releases = await github(`/repos/${REPOSITORY}/releases?per_page=100`);
  for (const { tag, files } of incompleteDrafts(releases)) log(`${tag} 草稿的附件不全（${files}/4），跳过：云端构建还在上传，或者上传失败了`);
  const drafts = pendingDrafts(releases);
  if (drafts.length === 0) return '没有等待搬运的草稿 release';
  const feed = await readFeed();
  for (const draft of drafts) {
    const version = draft.tag_name.slice(1);
    const order = compareVersions(version, feed.version);
    if (order < 0) {
      log(`${draft.tag_name} 低于更新源的 ${feed.version}，不搬运，草稿留着`);
      continue;
    }
    const commit = await tagCommit(draft.tag_name);
    const directory = join(config.cache, `${draft.tag_name}-${commit.slice(0, 12)}`);
    if (order === 0) {
      if (!(await draftFeed(draft, directory)).equals(feed.bytes)) {
        log(`${draft.tag_name} 草稿与更新源上的 ${version} 不是同一次构建，跳过，需要人工核对`);
        continue;
      }
      return publishDraft(draft);
    }
    const server = serverStatus();
    if (server.staged.includes(`${version}-${commit.slice(0, 12)}`)) {
      log(`${draft.tag_name} 已在服务器 staging，等服务器发布（一直不发布就看后台「软件更新」的最近一次自动发布）`);
      return `${draft.tag_name} 已在 staging，等服务器发布`;
    }
    if (server.uploading) {
      log(`服务器上有另一份上传正在进行，${draft.tag_name} 下次再传`);
      return '另一台机器正在上传';
    }
    log(`开始搬运 ${draft.tag_name}（提交 ${commit}，更新源当前 ${feed.version}）`);
    await upload(draft, version, commit, directory, { server, feed });
    const expected = await draftFeed(draft, directory);
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      const live = await readFeed().catch(error => { log(`读取更新源失败，稍后再读：${error.message}`); return null; });
      if (live?.bytes.equals(expected)) return publishDraft(draft);
    }
    log(`服务器 10 分钟内还没发布 ${draft.tag_name}，下次运行再转正式`);
    return `${draft.tag_name} 已上传，等服务器发布`;
  }
  return '没有要搬运的草稿（每份跳过的原因见上面的日志）';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--log') openLog(args[1]);
  else if (args.length !== 0) throw new Error('用法：node --use-env-proxy scripts/relay-release.mjs [--log <日志目录>]');
  if (!process.env.GITHUB_TOKEN) {
    process.env.GITHUB_TOKEN = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim();
  }
  try {
    log(`本次同步：${await relay()}`);
  } catch (error) {
    log(`本次同步失败（下次运行接着做）：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
