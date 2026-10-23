import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { load } from 'js-yaml';

/** The activation-free test package installs, stores data and registers apart from the official app:
 * NSIS derives the per-user install folder from the package name, Electron derives userData from productName. */
export const portableTestPackage = {
  appId: 'com.tuanbo.control.functionaltest',
  name: 'tuanbo-link-functional-test',
  productName: '团播联动台功能测试版',
  artifactPrefix: 'Tuanbo-Link-Test-NoActivation-'
};

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

/** A build-time test or internal distribution compiled into the main bundle (the define in electron.vite.config.ts).
 * The schema literals in internal-distribution.ts do not match: they read `channel: z.literal(...)`. */
export function embeddedDistributionChannel(bytes) {
  const match = /["']?channel["']?\s*:\s*["'](portable-test|internal)["']/.exec(bytes.toString('latin1'));
  return match ? match[1] : null;
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
