import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { load } from 'js-yaml';

export function validateReleaseVersion(rootPackage, desktopPackage, tag) {
  const version = desktopPackage.version;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('正式更新出口仅支持 X.Y.Z 稳定版本号');
  }
  if (rootPackage.version !== version) throw new Error('根包版本与桌面包版本不一致');
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`发布标签必须为 v${version}`);
  return version;
}

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Orders two X.Y.Z versions: negative when a is older. */
export function compareStableVersions(a, b) {
  const [left, right] = [a, b].map(value => {
    const match = stableVersion.exec(value);
    if (!match) throw new Error(`不是 X.Y.Z 正式版本号：${value}`);
    return match.slice(1).map(Number);
  });
  return left.map((part, index) => part - right[index]).find(difference => difference !== 0) ?? 0;
}

/** A release version is used once: newer than every other release tag and than the published feed.
 * Its own tag may already exist only on the commit being built. */
export function assertNewerRelease(version, { tags, head, feedVersion }) {
  for (const tag of tags) {
    const tagged = /^v(.+)$/.exec(tag.name)?.[1];
    if (!tagged || !stableVersion.test(tagged)) continue;
    if (tagged === version) {
      if (tag.commit !== head) throw new Error(`版本 ${version} 的标签 ${tag.name} 指向另一个提交，正式版本号不能重复使用`);
    } else if (compareStableVersions(tagged, version) >= 0) {
      throw new Error(`版本 ${version} 不高于已有标签 ${tag.name}`);
    }
  }
  if (compareStableVersions(feedVersion, version) >= 0) throw new Error(`版本 ${version} 不高于更新源上的 ${feedVersion}`);
}

/** Tagging `head` as v{version}: create the tag, keep it (already on head) or move it there. The tag may move only
 * while its version was never released: the feed is older (checked with the other tags) and GitHub has no release for
 * it, not even a draft that a relay could still publish. A release that failed before that keeps its version number. */
export function releaseTagPlan(version, { tags, head, feedVersion, hasRelease }) {
  const name = `v${version}`;
  assertNewerRelease(version, { tags: tags.filter(tag => tag.name !== name), head, feedVersion });
  const existing = tags.find(tag => tag.name === name);
  if (!existing) return 'create';
  if (existing.commit === head) return 'keep';
  if (hasRelease) throw new Error(`${name} 在 GitHub 上已有 release（含草稿），不能挪到新提交；先核对那个 release 再决定`);
  return 'move';
}

/** Version tags from `git for-each-ref refs/tags/v* --format='%(refname:short) %(objectname) %(*objectname)'`, each
 * with the commit it names (an annotated tag's own object is peeled). */
export function versionTags(forEachRef) {
  return forEachRef.split('\n').filter(Boolean).map(line => {
    const [name, object, peeled] = line.split(' ');
    return { name, commit: peeled || object };
  });
}

/** The version the live update feed serves, read from latest.yml next to the packaged publish URL. */
export async function feedVersionOf(publishUrl) {
  const feed = new URL('latest.yml', publishUrl);
  const response = await fetch(feed, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`读取线上更新源失败：${feed} HTTP ${response.status}`);
  const version = load(await response.text())?.version;
  if (typeof version !== 'string') throw new Error('线上 latest.yml 没有版本号');
  return version;
}

export function validatePackagedUpdateConfig(text, expected) {
  const config = load(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('app-update.yml 必须为对象');
  if (expected.provider !== 'generic' || config.provider !== expected.provider || config.url !== expected.url) {
    throw new Error('app-update.yml 与桌面包的公司更新源不一致');
  }
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/')) {
    throw new Error('更新源必须为无凭据的 HTTPS 目录地址');
  }
  if (/token:|github_pat_|ghp_|authorization:/i.test(text)) throw new Error('app-update.yml 不得包含访问凭据');
}

/** latest.yml must describe exactly the installer beside it. Its releaseDate is what clients compare with the
 * license's updatesUntil, so it must be a real ISO timestamp; the release manifest records it. */
export function validateUpdateMetadata(text, { version, installerName, installerBytes }) {
  const metadata = load(text);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('latest.yml 必须为对象');
  if (metadata.version !== version) throw new Error(`latest.yml 的版本 ${String(metadata.version)} 与安装包版本 ${version} 不一致`);
  const sha512 = createHash('sha512').update(installerBytes).digest('base64');
  if (metadata.path !== installerName || metadata.sha512 !== sha512) throw new Error('latest.yml 的 path 或 sha512 与安装包不一致');
  const files = metadata.files;
  if (!Array.isArray(files) || files.length !== 1 || files[0].url !== installerName || files[0].sha512 !== sha512 || files[0].size !== installerBytes.length) {
    throw new Error('latest.yml 的 files 与安装包不一致');
  }
  const releaseDate = metadata.releaseDate;
  if (typeof releaseDate !== 'string' || !Number.isFinite(Date.parse(releaseDate)) || new Date(releaseDate).toISOString() !== releaseDate) {
    throw new Error('latest.yml 缺少 ISO 格式的 releaseDate');
  }
  return { version, releaseDate, sha512 };
}

/** Strings only the development activation bypass carries (local-test-license.ts and its use in link-main.ts).
 * `electron-vite build --mode release` compiles that code out, so a bundle containing any of them is a development build. */
const developmentAccessMarkers = ['TBLINK_LOCAL_TEST_ACCESS', '.local-test-access', '本机开发测试通道'];

export function developmentAccessIn(bytes) {
  return developmentAccessMarkers.filter(marker => bytes.includes(Buffer.from(marker)));
}

/** Reads one file from an asar archive (Chromium pickle header, then JSON index, then file data). */
export function readAsarFile(archivePath, name) {
  const descriptor = openSync(archivePath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if (readSync(descriptor, prefix, 0, 16, 0) !== 16) throw new Error('asar 文件头不完整');
    const headerSize = prefix.readUInt32LE(4);
    const json = Buffer.alloc(prefix.readUInt32LE(12));
    readSync(descriptor, json, 0, json.length, 16);
    const entry = name.split('/').reduce((directory, segment) => directory?.files?.[segment], JSON.parse(json.toString('utf8')));
    if (!entry || typeof entry.size !== 'number' || typeof entry.offset !== 'string' || entry.unpacked) throw new Error(`asar 中没有 ${name}`);
    const data = Buffer.alloc(entry.size);
    if (readSync(descriptor, data, 0, entry.size, 8 + headerSize + Number(entry.offset)) !== entry.size) throw new Error(`asar 中的 ${name} 不完整`);
    return data;
  } finally {
    closeSync(descriptor);
  }
}

/** The download page's release record, derived from the published latest.yml. The date is the Beijing-time
 * date of releaseDate, the same instant clients compare with updatesUntil. */
export function websiteRelease(text, feedUrl) {
  const metadata = load(text);
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('latest.yml 必须为对象');
  const { version, path, releaseDate } = metadata;
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('官网只展示 X.Y.Z 正式版本');
  if (path !== `Tuanbo-Link-Console-${version}-x64.exe`) throw new Error(`latest.yml 的安装包名不是正式安装包：${String(path)}`);
  if (typeof releaseDate !== 'string' || !Number.isFinite(Date.parse(releaseDate))) throw new Error('latest.yml 缺少 releaseDate');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.parse(releaseDate));
  return { version, date, url: new URL(path, feedUrl).href, source: new URL('latest.yml', feedUrl).href, size: metadata.files?.[0]?.size };
}

/** The payload the release key signs; the desktop client (release-signature.ts) checks the same fields. */
function releasePayload({ version, releaseDate, file, size, sha512 }) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'tuanbo-link-console', channel: 'release', version, releaseDate, file, size, sha512 }));
}

/** Appends the release signature to latest.yml; refuses a key the client does not embed. */
export function signUpdateMetadata(text, { installerName, installerBytes, privateKey, kid, publicKeys }) {
  const metadata = load(text);
  if (metadata?.tblinkRelease !== undefined) throw new Error('latest.yml 已经带有发布签名');
  if (!publicKeys[kid]) throw new Error(`客户端没有内置密钥 ${kid} 的公钥，签名后无法校验`);
  const { version, releaseDate, sha512 } = validateUpdateMetadata(text, { version: metadata.version, installerName, installerBytes });
  const payload = releasePayload({ version, releaseDate, file: installerName, size: installerBytes.length, sha512 });
  const signature = sign(null, payload, privateKey);
  if (!verify(null, payload, createPublicKey(publicKeys[kid]), signature)) throw new Error(`私钥与内置公钥 ${kid} 不匹配`);
  return `${text.endsWith('\n') ? text : `${text}\n`}tblinkRelease:\n  kid: ${kid}\n  payload: ${payload.toString('base64url')}\n  signature: ${signature.toString('base64url')}\n`;
}

/** The kid of a valid release signature in latest.yml for this installer, or null when unsigned. */
export function verifyUpdateSignature(text, { installerName, installerBytes, publicKeys }) {
  const metadata = load(text);
  const envelope = metadata?.tblinkRelease;
  if (envelope === undefined) return null;
  const { kid, payload, signature } = envelope ?? {};
  if (typeof kid !== 'string' || typeof payload !== 'string' || typeof signature !== 'string') throw new Error('发布签名格式无效');
  if (!publicKeys[kid]) throw new Error(`发布签名使用了客户端没有内置的密钥 ${kid}`);
  const bytes = Buffer.from(payload, 'base64url');
  if (!verify(null, bytes, createPublicKey(publicKeys[kid]), Buffer.from(signature, 'base64url'))) throw new Error('发布签名无效');
  const { version, releaseDate, sha512 } = validateUpdateMetadata(text, { version: metadata.version, installerName, installerBytes });
  if (!bytes.equals(releasePayload({ version, releaseDate, file: installerName, size: installerBytes.length, sha512 }))) throw new Error('发布签名的内容与安装包不一致');
  return kid;
}
