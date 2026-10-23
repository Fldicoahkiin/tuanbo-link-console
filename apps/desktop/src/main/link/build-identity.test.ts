import { describe, expect, it } from 'vitest';
import desktopPackage from '../../../package.json';
import { releaseAppId, releaseChannel } from './build-identity';

describe('build identity', () => {
  it('names the channel from the packaged distribution', () => {
    expect(releaseChannel(true, null)).toBe('release');
    expect(releaseChannel(true, 'portable-test')).toBe('test');
    expect(releaseChannel(true, 'internal')).toBe('internal');
    expect(releaseChannel(false, 'portable-test')).toBe('development');
  });

  // verify-desktop-artifacts checks the test package's app.asar carries the appId its builder used.
  it('reports the appId each builder sets', () => {
    expect(releaseAppId(null, desktopPackage.build.appId)).toBe('com.tuanbo.control');
    expect(releaseAppId('portable-test', desktopPackage.build.appId)).toBe('com.tuanbo.control.functionaltest');
    expect(releaseAppId('internal', desktopPackage.build.appId)).toBe('com.tuanbo.control.internal');
  });
});
