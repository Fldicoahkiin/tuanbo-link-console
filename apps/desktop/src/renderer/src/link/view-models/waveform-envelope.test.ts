import { describe, expect, it } from 'vitest';
import { WaveformEnvelope } from './waveform-envelope';
describe('waveform viewport envelope', () => {
  it('retains single-sample transients through cached zoom levels without mutating decoded audio', () => {
    const source = new Float32Array(48000 * 30); source[555] = -.91; source[901111] = .87;
    const envelope = new WaveformEnvelope(source);
    for (const pixels of [400, 1600, 800, 400]) {
      const result = envelope.range(0, source.length, pixels);
      expect(result.length).toBe(pixels * 2); expect(Math.min(...result)).toBeCloseTo(-.91); expect(Math.max(...result)).toBeCloseTo(.87);
    }
    expect(source[555]).toBeCloseTo(-.91); expect(source[901111]).toBeCloseTo(.87);
  });
  it('does not include samples outside a trimmed interval or leak cached neighbouring extrema', () => {
    const source = new Float32Array(1024); source[255] = -1; source[300] = .4; source[700] = .9;
    const envelope = new WaveformEnvelope(source); envelope.range(0,1024,1);
    const result = envelope.range(256,700,2); expect(Math.min(...result)).toBe(0); expect(Math.max(...result)).toBeCloseTo(.4);
    expect(envelope.range(1024,2000,300).length).toBe(0);
  });
});
