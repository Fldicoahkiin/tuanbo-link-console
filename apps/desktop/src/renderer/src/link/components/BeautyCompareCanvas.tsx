import { useEffect, useRef, useState } from 'react';
import { beautyComparisonFrameSchema, type BeautyTarget } from '@tb/schema';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

let session: Promise<void> = Promise.resolve();
export function BeautyCompareCanvas({ target, onAspectChange }: { target: BeautyTarget; onAspectChange: (ratio: number) => void }): JSX.Element {
  const original = useRef<HTMLCanvasElement>(null), processed = useRef<HTMLCanvasElement>(null);
  const [split, setSplit] = useState(50), [aspect, setAspect] = useState(9 / 16);
  const [error, setError] = useState(''), [revision, setRevision] = useState(0), [visible, setVisible] = useState(false);
  const [received, setReceived] = useState(false);
  useEffect(() => {
    let active = true, eventReceived = false;
    const off = desktop.onWindowVisibilityChanged(value => { eventReceived = true; setVisible(value); });
    void desktop.getWindowVisible().then(value => { if (active && !eventReceived) setVisible(value); })
      .catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; off(); };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true, running = false;
    setError(''); setReceived(false);
    const run = async (): Promise<void> => {
      if (!active) return;
      running = true;
      try {
        await desktop.closeBeautyComparison();
        while (active) {
          const frame = beautyComparisonFrameSchema.parse(await desktop.readBeautyComparison({ sourceName: target.sourceName, filterName: target.filterName }));
          if (!active) break;
          for (const [ref, pixels] of [[original, frame.original], [processed, frame.processed]] as const) {
            const canvas = ref.current, context = canvas?.getContext('2d', { alpha: false });
            if (!canvas || !context || !(pixels.buffer instanceof ArrayBuffer)) throw new Error('无法绘制美颜对比画面');
            if (canvas.width !== frame.width || canvas.height !== frame.height) { canvas.width = frame.width; canvas.height = frame.height; }
            context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength), frame.width, frame.height), 0, 0);
          }
          setAspect(frame.width / frame.height); onAspectChange(frame.width / frame.height); setReceived(true);
        }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { await desktop.closeBeautyComparison(); running = false; }
    };
    session = session.then(run).catch((reason: unknown) => { if (active) setError(String(reason)); console.error('美颜对比关闭失败', reason); });
    return () => {
      active = false;
      if (running) void desktop.closeBeautyComparison().catch((reason: unknown) => console.error('关闭美颜对比失败', reason));
    };
  }, [target.sourceName, target.filterName, visible, revision, onAspectChange]);
  return <div className="obs-live-container beauty-comparison">
    <div className="obs-live-canvas" style={{ visibility: received && !error ? 'visible' : 'hidden', aspectRatio: aspect, width: `min(calc(100cqw - 8px), calc((100cqh - 8px) * ${aspect}))` }}>
      <canvas ref={processed} aria-label="美颜后画面" />
      <div className="beauty-comparison-original" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}><canvas ref={original} aria-label="美颜前画面" /></div>
      {received && !error ? <span className="beauty-comparison-divider" style={{ left: `${split}%` }} /> : null}
    </div>
    <div className="beauty-comparison-label">{target.sourceName} · 美颜前 / 美颜后</div>
    {error ? <div className="beauty-comparison-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新读取对比</button></div>
      : !received ? <div className="beauty-comparison-loading" role="status">正在读取同帧对比…</div> : null}
    {received && !error ? <label className="beauty-comparison-split">前<input aria-label="美颜对比分割线" type="range" min="0" max="100" value={split} onChange={event => setSplit(Number(event.target.value))} />后</label> : null}
  </div>;
}
