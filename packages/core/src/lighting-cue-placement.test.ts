import { describe, expect, it } from 'vitest';
import { createLightingDocument } from '@tb/schema';
import { placeConsoleCue } from './lighting-cue-placement';

const reference = { sequence: 168, cue: '1.250', executor: '', name: '蓝色扫光' };
describe('direct console Cue placement', () => {
  it('preserves the exact reference and existing timing without inventing a library entry', () => {
    const original = createLightingDocument();
    const first = placeConsoleCue(original, reference, 1250, 5000);
    const before = structuredClone(first);
    const next = placeConsoleCue(first, { ...reference, cue: '2.000' }, 2500, 5000);
    expect(first).toEqual(before);
    expect(next.tempos).toEqual(original.tempos);
    expect(next.templates).toEqual(original.templates);
    expect(next.tracks).toHaveLength(1);
    expect(next.tracks[0]!.clips[0]!.events).toEqual([
      before.tracks[0]!.clips[0]!.events[0],
      expect.objectContaining({ kind: 'ma2', at: 2500, cue: '2.000', sequence: 168, executor: '' })
    ]);
    expect(next.tracks[0]!.clips[0]!.events.every(event => event.librarySource === undefined)).toBe(true);
    expect(original.tracks).toHaveLength(0);
  });
  it('does not insert into a locked or muted track', () => {
    for (const flag of ['locked', 'muted'] as const) {
      const initial = placeConsoleCue(createLightingDocument(), reference, 1000, 5000);
      initial.tracks[0]![flag] = true;
      const next = placeConsoleCue(initial, reference, 2000, 5000);
      expect(next.tracks).toHaveLength(2);
      expect(next.tracks[0]).toEqual(initial.tracks[0]);
    }
  });
  it('rejects invalid placement times and conflicting executor references', () => {
    for (const time of [-1, Number.NaN, Number.POSITIVE_INFINITY, 5000]) expect(() => placeConsoleCue(createLightingDocument(), reference, time, 5000)).toThrow('Cue 超出歌曲范围');
    const first = placeConsoleCue(createLightingDocument(), { ...reference, executor: '1.101' }, 1000, 5000);
    expect(() => placeConsoleCue(first, { ...reference, sequence: 169, cue: '2', executor: '1.101' }, 1000, 5000)).toThrow();
  });
});
