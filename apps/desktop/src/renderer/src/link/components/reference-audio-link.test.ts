import { expect, test } from 'vitest';
import { matchedReferenceAudioUrl } from './reference-audio-link';

const songA = { relativePath: 'assets/reference-audio/a.wav', sha256: 'a'.repeat(64) };
const songB = { relativePath: 'assets/reference-audio/b.wav', sha256: 'b'.repeat(64) };

test('a song only gets the audio link resolved for that song', () => {
  // 2026-11-11 the home player paired song A's link with song B for one render; the waveform of A
  // was then generated and saved for B. Until B's own link arrives there is no link at all.
  const resolvedA = { projectPath: 'show.tblink', ...songA, url: 'tblink-asset://a' };
  expect(matchedReferenceAudioUrl(resolvedA, 'show.tblink', songA)).toBe('tblink-asset://a');
  expect(matchedReferenceAudioUrl(resolvedA, 'show.tblink', songB)).toBeNull();
  expect(matchedReferenceAudioUrl(resolvedA, 'show.tblink', { ...songA, sha256: songB.sha256 })).toBeNull();
  expect(matchedReferenceAudioUrl(resolvedA, 'other.tblink', songA)).toBeNull();
  expect(matchedReferenceAudioUrl(resolvedA, 'show.tblink', undefined)).toBeNull();
  expect(matchedReferenceAudioUrl(null, 'show.tblink', songA)).toBeNull();
});
