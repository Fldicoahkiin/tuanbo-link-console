import type { LinkReleaseChannel } from '@tb/core/link';
import desktopPackage from '../../../package.json';

/** Commit the main bundle was built from, with `-dirty` for uncommitted changes; null when the build had no Git. */
declare const __TBLINK_GIT_SHA__: string | null;
export const buildGitSha: string | null = typeof __TBLINK_GIT_SHA__ === 'undefined' ? null : __TBLINK_GIT_SHA__;

export const buildVersion: string = desktopPackage.version;

export const releaseChannelLabel: Record<LinkReleaseChannel, string> = { release: '正式', development: '开发' };

/** Every packaged build is the official release (packaging refuses development builds); an unpackaged app is development. */
export function releaseChannel(packaged: boolean): LinkReleaseChannel {
  return packaged ? 'release' : 'development';
}
