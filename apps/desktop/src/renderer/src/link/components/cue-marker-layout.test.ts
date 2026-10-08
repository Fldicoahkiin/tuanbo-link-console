import { describe, expect, it } from 'vitest';
import { displayCueNumber, layoutCueMarkers } from './cue-marker-layout';

describe('Cue labels on the waveform', () => {
  it('displays fractional Cue numbers without meaningless trailing zeroes', () => {
    expect(['1.000', '1.250', '1.010', '50', '10.001', '—'].map(displayCueNumber)).toEqual(['1', '1.25', '1.01', '50', '10.001', '—']);
  });
  it('keeps two overlapping labels on two rows at their exact positions', () => {
    const points = [{ id: 'a', cue: '1', ms: 1000 }, { id: 'b', cue: '2', ms: 1013 }];
    const groups = layoutCueMarkers(points, 100);
    expect(groups.map(value => [value.row, value.clustered])).toEqual([[0, false], [1, false]]);
    expect(groups[0]!.left).toBeCloseTo(100, 8);
    expect(groups[1]!.left).toBeCloseTo(101.3, 8);
  });
  it('clusters crowded labels without dropping identities or mutating data', () => {
    const points = Array.from({ length: 12 }, (_, i) => ({ id: String(i), cue: String(i), ms: 1000 + i * 13 }));
    const original = structuredClone(points);
    const groups = layoutCueMarkers(points, 10);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ids).toEqual(points.map(value => value.id));
    expect(groups[0]!.clustered).toBe(true);
    expect(points).toEqual(original);
    expect(layoutCueMarkers(points, 6000).every(value => !value.clustered)).toBe(true);
  });
  it('keeps isolated Cue labels independent of the dense group', () => {
    const points = [0, 1, 2, 10000].map((ms, i) => ({ id: String(i), cue: '1', ms }));
    const groups = layoutCueMarkers(points, 20);
    expect(groups.map(value => value.ids.length)).toEqual([3, 1]);
    expect(groups.every(value => value.row <= 1)).toBe(true);
  });
});
