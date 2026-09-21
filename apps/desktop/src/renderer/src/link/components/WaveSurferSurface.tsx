import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';

/** Rendering only: the app remains the sole transport and edit authority. */
export function WaveSurferSurface({ channels, duration, allowSpectrum = false }: {
  channels: Float32Array[]; duration: number; allowSpectrum?: boolean;
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const wave = useRef<HTMLDivElement>(null);
  const spectrum = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!host.current || !wave.current || !spectrum.current) return;
    const element = host.current, waveElement = wave.current, spectrumElement = spectrum.current;
    const timeline = element.closest('.reference-timeline');
    let disposed = false;
    let plugin: Spectrogram | null = null;
    let configuration = '';
    delete element.dataset.ready;
    setError(null);
    const report = (reason: Error): void => { if (!disposed) { setError(`波形显示失败：${reason.message}`); console.error('WaveSurfer', reason); } };
    const instance = WaveSurfer.create({
      container: waveElement, height: Math.max(1, element.clientHeight),
      interact: false, cursorWidth: 0, autoScroll: false, autoCenter: false,
      hideScrollbar: true, normalize: false, waveColor: '#68c9ed', progressColor: '#68c9ed'
    });
    instance.on('error', report);
    instance.on('redrawcomplete', () => { if (!disposed) element.dataset.ready = 'true'; });
    const display = (): void => {
      const height = Math.max(1, element.clientHeight);
      const gain = Number(getComputedStyle(element).getPropertyValue('--waveform-gain')) || 1;
      const spectral = allowSpectrum && timeline?.getAttribute('data-waveform-mode') === 'spectrum';
      const next = `${height}:${gain}:${spectral}`;
      if (next === configuration) return;
      configuration = next;
      instance.setOptions({ height, barHeight: gain });
      waveElement.style.visibility = spectral ? 'hidden' : 'visible';
      plugin?.destroy(); plugin = null;
      if (spectral) {
        plugin = Spectrogram.create({ container: spectrumElement, height, labels: true,
          fftSamples: 1024, scale: 'logarithmic', frequencyMin: 40, frequencyMax: 16000,
          gainDB: 20, rangeDB: 70, useWebWorker: true, fallbackToMainThread: false });
        plugin.on('error', report);
        instance.registerPlugin(plugin);
      }
    };
    display();
    void instance.load('', channels, duration).catch((reason: unknown) => report(reason instanceof Error ? reason : new Error(String(reason))));
    const resize = new ResizeObserver(display); resize.observe(element);
    const settings = new MutationObserver(display);
    if (timeline) settings.observe(timeline, { attributes: true, attributeFilter: ['style', 'data-waveform-mode'] });
    return () => { disposed = true; resize.disconnect(); settings.disconnect(); instance.destroy(); };
  }, [channels, duration, allowSpectrum]);
  return <div ref={host} className="wavesurfer-surface" data-waveform-engine="wavesurfer">
    <div ref={wave} className="wavesurfer-wave" /><div ref={spectrum} className="wavesurfer-spectrum" />
    {error ? <span className="timeline-lane-error">{error}</span> : null}
  </div>;
}
