import { expect, it } from 'vitest';
import { releaseChannel } from './build-identity';

it('a packaged app is the official release, an unpackaged one is development', () => {
  expect(releaseChannel(true)).toBe('release');
  expect(releaseChannel(false)).toBe('development');
});
