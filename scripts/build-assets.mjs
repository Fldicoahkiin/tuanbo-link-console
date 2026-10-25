// The pinned beauty build and music-analysis runtime are not in git. Each lives once in a GitHub release of its own,
// build-assets-<kind>-<first 12 of its pin>, as a gzip tar split into parts below GitHub's 2 GiB asset limit and a
// build-assets.json that lists them. The cloud build fetches them into artifacts/; afterPack then checks the files
// against release-pin.json, so a wrong upload fails the build.
//   node scripts/build-assets.mjs pack <kind> <directory> <out>   tar and split a pinned directory (on the builder)
//   node scripts/build-assets.mjs publish <kind> <out>            create the release and upload the parts (once)
//   node scripts/build-assets.mjs fetch <kind>                    download, check and unpack (cloud build)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPOSITORY, downloadAsset, github, uploadAsset } from './github-releases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ASSETS = {
  beauty: { pin: 'tools/obs/beauty/release-pin.json', target: 'artifacts/beauty-prototype' },
  'music-analysis': { pin: 'tools/music-analysis/release-pin.json', target: 'artifacts/music-analysis' }
};
const PART_BYTES = 1900 * 1024 * 1024;

export const assetTag = (kind, pin) => `build-assets-${kind}-${pin.slice(0, 12)}`;

async function pinOf(kind) {
  if (!ASSETS[kind]) throw new Error(`没有这种构建资产：${kind}`);
  return JSON.parse(await readFile(join(root, ASSETS[kind].pin), 'utf8')).outputs.sha256;
}

/** Splits a file into <file>.001, .002, … of at most partBytes each; returns each part's name, size and sha256. */
export async function splitFile(path, partBytes) {
  const parts = [];
  const { size } = await stat(path);
  for (let start = 0, index = 1; start < size; start += partBytes, index += 1) {
    const name = `${basename(path)}.${String(index).padStart(3, '0')}`;
    const hash = createHash('sha256');
    const output = createWriteStream(join(dirname(path), name));
    for await (const chunk of createReadStream(path, { start, end: Math.min(start + partBytes, size) - 1 })) {
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end(error => (error ? reject(error) : resolve())));
    parts.push({ name, size: Math.min(partBytes, size - start), sha256: hash.digest('hex') });
  }
  return parts;
}

/** The release's build-assets.json must describe this kind and the pin in the repository. */
export function checkDescriptor(descriptor, kind, pin) {
  if (descriptor?.version !== 1 || descriptor.kind !== kind || descriptor.pin !== pin || !Array.isArray(descriptor.parts) || descriptor.parts.length === 0) {
    throw new Error(`${kind} 的 build-assets.json 与仓库里的 release-pin.json 不一致`);
  }
  return descriptor.parts;
}

async function pack(kind, directory, out) {
  const pin = await pinOf(kind);
  await mkdir(out, { recursive: true });
  const archive = join(out, `${kind}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', directory, '.'], { stdio: 'inherit', windowsHide: true, timeout: 60 * 60_000 });
  if (tar.status !== 0) throw new Error(`打包 ${directory} 失败（tar 退出码 ${tar.status}）`);
  const parts = await splitFile(archive, PART_BYTES);
  await writeFile(join(out, 'build-assets.json'), `${JSON.stringify({ version: 1, kind, pin, parts }, null, 2)}\n`);
  console.log(`${kind}：${parts.length} 个分卷，共 ${parts.reduce((sum, part) => sum + part.size, 0)} 字节，标签 ${assetTag(kind, pin)}`);
}

/** Creates the release, or picks up one an earlier run left half uploaded: parts already uploaded whole are kept, a
 * part left broken is replaced, and build-assets.json goes last, so a fetch never sees a release without all parts. */
async function publish(kind, out) {
  const pin = await pinOf(kind);
  const tag = assetTag(kind, pin);
  const descriptorBytes = await readFile(join(out, 'build-assets.json'));
  const parts = checkDescriptor(JSON.parse(descriptorBytes), kind, pin);
  const release = await github(`/repos/${REPOSITORY}/releases/tags/${tag}`, { allow404: true }) ?? await github(`/repos/${REPOSITORY}/releases`, { method: 'POST', body: {
    tag_name: tag, target_commitish: 'master', name: tag, prerelease: true, make_latest: 'false',
    body: `构建用的固定资产（${kind}），指纹 ${pin}，与 ${ASSETS[kind].pin} 一致。只给 Release Windows 下载，不是软件版本。` } });
  if (release.assets.some(asset => asset.name === 'build-assets.json')) throw new Error(`${tag} 已经完整发布，不覆盖`);
  for (const part of parts) {
    const existing = release.assets.find(asset => asset.name === part.name);
    if (existing?.state === 'uploaded' && existing.size === part.size) {
      console.log(`${part.name} 已上传，跳过`);
      continue;
    }
    if (existing) await github(`/repos/${REPOSITORY}/releases/assets/${existing.id}`, { method: 'DELETE' });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(join(out, part.name))) hash.update(chunk);
    if (hash.digest('hex') !== part.sha256) throw new Error(`${part.name} 与 build-assets.json 不一致`);
    console.log(`已上传 ${part.name}（${await uploadAsset(release, part.name, join(out, part.name))} 字节）`);
  }
  await uploadAsset(release, 'build-assets.json', join(out, 'build-assets.json'));
  console.log(`已发布 ${tag}：${release.html_url}`);
}

async function fetchAssets(kind) {
  const pin = await pinOf(kind);
  const tag = assetTag(kind, pin);
  const release = await github(`/repos/${REPOSITORY}/releases/tags/${tag}`, { allow404: true });
  if (!release) throw new Error(`没有 ${tag}：先在构建机上用 build-assets.mjs pack 和 publish 上传这份资产`);
  const asset = name => {
    const found = release.assets.find(item => item.name === name);
    if (!found) throw new Error(`${tag} 缺少 ${name}`);
    return found;
  };
  const descriptorPath = join(tmpdir(), `${tag}.json`);
  await downloadAsset(asset('build-assets.json'), descriptorPath);
  const parts = checkDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')), kind, pin);
  const target = join(root, ASSETS[kind].target);
  await mkdir(target, { recursive: true });
  // The parts go straight into tar: the joined archive is never written, which keeps the runner's disk free.
  const tar = spawn('tar', ['-xzf', '-', '-C', target], { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  const exited = new Promise(resolve => tar.once('close', resolve));
  try {
    for (const part of parts) {
      const { sha256, size } = await downloadAsset(asset(part.name), tar.stdin);
      if (sha256 !== part.sha256 || size !== part.size) throw new Error(`${part.name} 与 build-assets.json 不一致`);
      console.log(`已下载并校验 ${part.name}（${size} 字节）`);
    }
  } catch (error) {
    tar.kill();
    throw error;
  }
  tar.stdin.end();
  const code = await exited;
  if (code !== 0) throw new Error(`解开 ${tag} 失败（tar 退出码 ${code}）`);
  console.log(`${kind} 已解到 ${ASSETS[kind].target}，afterPack 会再按 release-pin.json 核对每个文件`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, kind, ...rest] = process.argv.slice(2);
  if (command === 'pack' && rest.length === 2) await pack(kind, resolve(rest[0]), resolve(rest[1]));
  else if (command === 'publish' && rest.length === 1) await publish(kind, resolve(rest[0]));
  else if (command === 'fetch' && rest.length === 0) await fetchAssets(kind);
  else throw new Error('用法：node scripts/build-assets.mjs pack <kind> <目录> <输出目录> | publish <kind> <输出目录> | fetch <kind>');
}
