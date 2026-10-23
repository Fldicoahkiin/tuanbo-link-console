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
