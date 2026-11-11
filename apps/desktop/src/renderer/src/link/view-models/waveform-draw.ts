import type { LinkWaveform, LinkWaveformLevel } from '@tb/schema';
import { waveformNormalization } from './waveform-viewport';

/**
 * Drawing a song's waveform from the main process's levels (E10). Every waveform on screen goes through here:
 * the home player, the editor and the three lighting displays. Nothing here decodes audio; the cost of a
 * redraw follows the canvas width, whatever the zoom.
 */
export type WaveformDisplay = 'waveform' | 'rhythm' | 'spectrum';
export function waveformDisplay(value: string): WaveformDisplay {
  return value === 'rhythm' || value === 'spectrum' ? value : 'waveform';
}

/** The part of the source file one canvas shows, in samples, and how many columns it has. */
export type WaveformWindow = { startSample: number; endSample: number; columns: number };

export function waveformBytes(waveform: LinkWaveform): number {
  let bytes = waveform.spectrum?.data.byteLength ?? 0;
  for (const level of waveform.levels) bytes += level.wave.byteLength + (level.rhythm?.byteLength ?? 0);
  return bytes;
}

/** The coarsest level that still has a bucket for every column; past the finest level, the finest. */
export function waveformLevelFor(waveform: LinkWaveform, samplesPerColumn: number): LinkWaveformLevel {
  let chosen = waveform.levels[0]!;
  for (const level of waveform.levels) if (level.samplesPerBucket <= samplesPerColumn) chosen = level;
  return chosen;
}

/**
 * Lowest and highest value of each column in full scale, [min0, max0, min1, max1, …]. A column outside the
 * source gets min > max and is not drawn. Every bucket that overlaps a column counts, so a narrow kick never
 * falls between two columns.
 */
export function waveformColumnRange(waveform: LinkWaveform, band: 'wave' | 'rhythm', window: WaveformWindow): Float32Array {
  const columns = Math.max(1, Math.ceil(window.columns)), out = new Float32Array(columns * 2);
  const span = Math.max(1e-9, window.endSample - window.startSample), perColumn = span / columns;
  const level = waveformLevelFor(waveform, perColumn), data = band === 'rhythm' ? level.rhythm : level.wave;
  const buckets = (data?.length ?? 0) / 2;
  for (let column = 0; column < columns; column++) {
    const from = window.startSample + column * perColumn, to = from + perColumn;
    const first = Math.max(0, Math.floor(from / level.samplesPerBucket));
    const last = Math.min(buckets - 1, Math.max(first, Math.ceil(to / level.samplesPerBucket) - 1));
    let min = 1, max = -1;
    if (data && from < waveform.sampleCount && to > 0) {
      for (let bucket = first; bucket <= last; bucket++) {
        const low = data[bucket * 2]! / 32767, high = data[bucket * 2 + 1]! / 32767;
        if (low < min) min = low; if (high > max) max = high;
      }
    }
    out[column * 2] = min; out[column * 2 + 1] = max;
  }
  return out;
}

const scales = new WeakMap<LinkWaveformLevel, { wave: number; rhythm: number }>();
/** The level drawn at full height: the 96th percentile of the finest level, as the home player and editor did. */
export function waveformScale(waveform: LinkWaveform, band: 'wave' | 'rhythm'): number {
  const finest = waveform.levels[0]!;
  let cached = scales.get(finest);
  if (!cached) {
    const peaks = (data: Int16Array | null): number => {
      if (!data) return 1;
      const values = new Float64Array(data.length / 2);
      for (let index = 0; index < values.length; index++) values[index] = Math.max(Math.abs(data[index * 2]!), Math.abs(data[index * 2 + 1]!)) / 32767;
      return waveformNormalization(values);
    };
    cached = { wave: peaks(finest.wave), rhythm: peaks(finest.rhythm) };
    scales.set(finest, cached);
  }
  return cached[band];
}

/** Bars as tall as each column's loudest sample, mirrored around the centre line, at least one device pixel
 * tall. Mirrored as every waveform in the app was drawn before E10, so a low bass note reads as a band, not
 * as stripes of its own cycles. */
export function paintWaveform(context: CanvasRenderingContext2D, columns: Float32Array, options: { width: number; height: number; scale: number; color: string; fill: number }): void {
  const center = options.height / 2, reach = center * options.fill / options.scale, count = columns.length / 2;
  const columnWidth = options.width / count;
  context.fillStyle = options.color;
  for (let column = 0; column < count; column++) {
    const min = columns[column * 2]!, max = columns[column * 2 + 1]!;
    if (min > max) continue;
    const half = Math.min(center, Math.max(Math.abs(min), Math.abs(max)) * reach);
    context.fillRect(column * columnWidth, center - half, Math.max(1, columnWidth), Math.max(1, half * 2));
  }
}

/** Approximates the "roseus" colour map the spectrum used before E10, so it reads the same. */
const SPECTRUM_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1], [0, 30, 59], [55, 37, 134], [131, 22, 161], [195, 40, 132], [237, 87, 87], [252, 148, 73], [238, 210, 147], [254, 251, 249]
];
const SPECTRUM_COLORS = (() => {
  const table = new Uint8ClampedArray(256 * 3);
  for (let value = 0; value < 256; value++) {
    const position = value / 255 * (SPECTRUM_STOPS.length - 1), index = Math.min(SPECTRUM_STOPS.length - 2, Math.floor(position)), weight = position - index;
    for (let channel = 0; channel < 3; channel++) table[value * 3 + channel] = SPECTRUM_STOPS[index]![channel]! * (1 - weight) + SPECTRUM_STOPS[index + 1]![channel]! * weight;
  }
  return table;
})();
const SPECTRUM_LABELS: ReadonlyArray<readonly [number, string]> = [[100, '100 Hz'], [1000, '1 kHz'], [10_000, '10 kHz']];

/** Each column takes the loudest of the frames it covers per band; rows follow the bands on a log scale. */
export function paintSpectrum(context: CanvasRenderingContext2D, waveform: LinkWaveform, window: WaveformWindow, options: { width: number; height: number; labels: string | null; font: string }): void {
  const spectrum = waveform.spectrum;
  const width = Math.max(1, Math.round(options.width)), height = Math.max(1, Math.round(options.height));
  if (!spectrum) return;
  const image = context.createImageData(width, height), bands = spectrum.bands, column = new Float32Array(bands);
  const perColumn = (window.endSample - window.startSample) / width;
  for (let x = 0; x < width; x++) {
    const from = window.startSample + x * perColumn;
    if (from >= waveform.sampleCount || from + perColumn <= 0) continue;
    const first = Math.max(0, Math.floor(from / spectrum.hopSamples));
    const last = Math.min(spectrum.frames - 1, Math.max(first, Math.ceil((from + perColumn) / spectrum.hopSamples) - 1));
    column.fill(0);
    for (let frame = first; frame <= last; frame++) {
      const offset = frame * bands;
      for (let band = 0; band < bands; band++) { const value = spectrum.data[offset + band]!; if (value > column[band]!) column[band] = value; }
    }
    for (let y = 0; y < height; y++) {
      const position = (1 - (y + 0.5) / height) * (bands - 1), low = Math.floor(position), weight = position - low;
      const value = Math.round(column[low]! * (1 - weight) + column[Math.min(bands - 1, low + 1)]! * weight);
      const pixel = (y * width + x) * 4;
      image.data[pixel] = SPECTRUM_COLORS[value * 3]!; image.data[pixel + 1] = SPECTRUM_COLORS[value * 3 + 1]!; image.data[pixel + 2] = SPECTRUM_COLORS[value * 3 + 2]!; image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  if (options.labels === null) return;
  context.fillStyle = options.labels; context.font = options.font; context.textBaseline = 'middle';
  const span = Math.log(spectrum.maxHz / spectrum.minHz);
  for (const [hz, label] of SPECTRUM_LABELS) {
    const y = (1 - Math.log(hz / spectrum.minHz) / span) * height;
    if (y > 8 && y < height - 8) context.fillText(label, 4, y);
  }
}

/** One canvas, one display: sizes the canvas to its box and draws what `window` of the source shows. */
export function drawWaveformCanvas(canvas: HTMLCanvasElement, bounds: { width: number; height: number }, waveform: LinkWaveform, view: {
  display: WaveformDisplay; startSample: number; endSample: number; color: string; fill: number; labels: string | null; font: string; maximumWidth?: number;
  /** true: the song's 96th percentile fills the height (home player, editor overview, clip audio). false: full
   * scale fills it, so loud and quiet parts keep their difference (audio segments, the lighting displays). */
  normalize: boolean;
}): void {
  const scale = globalThis.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.min(view.maximumWidth ?? Infinity, Math.floor(bounds.width * scale)));
  canvas.height = Math.max(1, Math.floor(bounds.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法绘制波形');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const window = { startSample: view.startSample, endSample: view.endSample, columns: canvas.width };
  if (view.display === 'spectrum' && waveform.spectrum) {
    paintSpectrum(context, waveform, window, { width: canvas.width, height: canvas.height, labels: view.labels, font: view.font.replace(/(\d+(?:\.\d+)?)px/, (_, size: string) => `${Number(size) * scale}px`) });
    return;
  }
  // Until the rhythm band is generated (an older cache is shown), the plain waveform stands in; the lane says so.
  const band = view.display === 'rhythm' && waveform.levels[0]!.rhythm ? 'rhythm' : 'wave';
  paintWaveform(context, waveformColumnRange(waveform, band, window), { width: canvas.width, height: canvas.height, scale: view.normalize ? waveformScale(waveform, band) : 1, color: view.color, fill: view.fill });
}

/** Whether `display` can be drawn as asked, or an older cache stands in until the song is generated again. */
export function waveformDisplayReady(waveform: LinkWaveform, display: WaveformDisplay): boolean {
  return display === 'waveform' || (display === 'rhythm' ? waveform.levels[0]!.rhythm !== null : waveform.spectrum !== null);
}
