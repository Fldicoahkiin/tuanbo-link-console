import type { LinkReleaseChannel } from '@tb/core/link';

/** Commit the main bundle was built from, with `-dirty` for uncommitted changes; null when the build had no Git. */
declare const __TBLINK_GIT_SHA__: string | null;
export const buildGitSha: string | null = typeof __TBLINK_GIT_SHA__ === 'undefined' ? null : __TBLINK_GIT_SHA__;

export const releaseChannelLabel: Record<LinkReleaseChannel, string> = { release: '正式', test: '测试', internal: '内测', development: '开发' };

/** The channel follows the build-time distribution; an unpackaged app is development whatever it carries. */
export function releaseChannel(packaged: boolean, distribution: 'portable-test' | 'internal' | null): LinkReleaseChannel {
  if (!packaged) return 'development';
  return distribution === 'portable-test' ? 'test' : distribution === 'internal' ? 'internal' : 'release';
}

/** The packager's appId is not readable at runtime; the test and internal builders set these (scripts/release-config.mjs,
 * electron-builder.internal.cjs), the official one is package.json build.appId. */
export function releaseAppId(distribution: 'portable-test' | 'internal' | null, officialAppId: string): string {
  return distribution === 'portable-test' ? 'com.tuanbo.control.functionaltest' : distribution === 'internal' ? 'com.tuanbo.control.internal' : officialAppId;
}
