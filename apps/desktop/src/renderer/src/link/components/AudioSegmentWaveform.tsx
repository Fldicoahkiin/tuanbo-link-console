import { useEffect, useRef } from 'react';

/** A viewport-sized canvas keeps long songs cheap while the waveform follows its clip. */
export function AudioSegmentWaveform({ peaks, sourceStartMs, sourceDurationMs, durationMs, pixelsPerSecond, scrollLeft, viewportWidth, startMs }: {
  peaks: readonly number[]; sourceStartMs: number; sourceDurationMs: number; durationMs: number;
  pixelsPerSecond: number; scrollLeft: number; viewportWidth: number; startMs: number;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const left = Math.max(0, scrollLeft - startMs / 1000 * pixelsPerSecond);
  const width = Math.max(0, Math.min(durationMs / 1000 * pixelsPerSecond - left, viewportWidth));
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = (): void => {
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * scale));
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('音频波形 Canvas 不可用');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = getComputedStyle(canvas).color;
      const samplesPerPixel = 1000 / pixelsPerSecond / sourceDurationMs * peaks.length;
      ctx.beginPath(); ctx.moveTo(0, canvas.height);
      for (let x = 0; x < canvas.width; x++) {
        const position = (sourceStartMs / sourceDurationMs * peaks.length) + (left + x / scale) * samplesPerPixel;
        const first = Math.max(0, Math.floor(position));
        const last = Math.min(peaks.length, Math.max(first + 1, Math.ceil(position + samplesPerPixel / scale)));
        let peak = 0;
        for (let index = first; index < last; index++) peak = Math.max(peak, peaks[index]!);
        ctx.lineTo(x, canvas.height - Math.min(1, peak) * (canvas.height - 2 * scale));
      }
      ctx.lineTo(canvas.width, canvas.height); ctx.closePath(); ctx.fill();
    };
    draw(); const observer = new ResizeObserver(draw); observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, sourceStartMs, sourceDurationMs, pixelsPerSecond, left, width]);
  return <canvas ref={ref} className="audio-segment-waveform" style={{ left, width }} />;
}
