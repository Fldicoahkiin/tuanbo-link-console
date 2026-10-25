import { describe, expect, it } from 'vitest';
import type { LinkUpdateStatus } from '@tb/core/link';
import { pendingUpdateVersion } from './update-availability';

const base: LinkUpdateStatus = { phase: 'idle', currentVersion: '0.5.2', availableVersion: null, releaseDate: null, progressPercent: null,
  transferredBytes: null, totalBytes: null, feedConfigured: true, installBlockedReason: null, message: '' };

describe('pendingUpdateVersion', () => {
  it('发现、下载中、已下载的新版本都提示，装不了的版本不提示', () => {
    expect(pendingUpdateVersion(null)).toBeNull();
    expect(pendingUpdateVersion({ ...base, phase: 'upToDate' })).toBeNull();
    for (const phase of ['available', 'downloading', 'downloaded'] as const) expect(pendingUpdateVersion({ ...base, phase, availableVersion: '0.5.3' })).toBe('0.5.3');
    expect(pendingUpdateVersion({ ...base, phase: 'available', availableVersion: '0.5.3', installBlockedReason: '授权的升级期限已过' })).toBeNull();
    expect(pendingUpdateVersion({ ...base, phase: 'error', availableVersion: '0.5.3' })).toBeNull();
  });
});
