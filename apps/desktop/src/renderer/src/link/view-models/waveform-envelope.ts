/** Shared extrema cache; rendering cost follows visible pixels, not decoded samples. */
export class WaveformEnvelope {
  private readonly minima: Float32Array;
  private readonly maxima: Float32Array;
  private readonly ready: Uint8Array;
  private readonly blockSize = 256;
  constructor(private readonly source: Float32Array) {
    const length = Math.ceil(source.length / this.blockSize);
    this.minima = new Float32Array(length); this.maxima = new Float32Array(length); this.ready = new Uint8Array(length);
  }
  range(start: number, end: number, pixels: number): Float32Array {
    const first = Math.max(0, Math.floor(start)), last = Math.min(this.source.length, Math.ceil(end));
    if (last <= first) return new Float32Array();
    const count = Math.min(last - first, Math.max(1, Math.ceil(pixels)));
    const output = new Float32Array(count * 2);
    for (let column = 0; column < count; column++) {
      const a = first + Math.floor(column * (last - first) / count), b = first + Math.floor((column + 1) * (last - first) / count);
      let min = 0, max = 0, cursor = a;
      while (cursor < b) {
        const block = Math.floor(cursor / this.blockSize), boundary = Math.min(this.source.length, (block + 1) * this.blockSize);
        if (cursor % this.blockSize === 0 && boundary <= b) {
          if (!this.ready[block]) {
            let low = 0, high = 0;
            for (let i = cursor; i < boundary; i++) { const value = this.source[i]!; if (value < low) low = value; if (value > high) high = value; }
            this.minima[block] = Math.max(-1, low); this.maxima[block] = Math.min(1, high); this.ready[block] = 1;
          }
          min = Math.min(min, this.minima[block]!); max = Math.max(max, this.maxima[block]!); cursor = boundary;
        } else { const value = this.source[cursor++]!; if (value < min) min = value; if (value > max) max = value; }
      }
      output[column * 2] = Math.max(-1, min); output[column * 2 + 1] = Math.min(1, max);
    }
    return output;
  }
}
