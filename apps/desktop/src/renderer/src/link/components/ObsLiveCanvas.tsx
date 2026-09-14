import { useEffect, useRef, useState } from 'react';
import { obsLiveSceneSchema, type ObsLiveEdit, type ObsLiveScene } from '@tb/schema';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { ObsLiveSelection } from './ObsLiveSelection';

let liveSession: Promise<void> = Promise.resolve();

export function ObsLiveCanvas(): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<ObsLiveScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const pending = useRef<ObsLiveEdit | null>(null);
  const sending = useRef(false);
  const editing = useRef(false);
  const [restart, setRestart] = useState(0);
  useEffect(() => {
    let active = true;
    let busy = false, dirty = false;
    const refresh = async (): Promise<void> => {
      if (busy) { dirty = true; return; }
      busy = true;
      try { const next = obsLiveSceneSchema.parse(await desktop.readObsLiveScene()); if (active && !editing.current && !sending.current) setScene(next); }
      catch (reason) { if (active) setError(String(reason)); }
      finally { busy = false; if (dirty && active) { dirty = false; void refresh(); } }
    };
    const unsubscribe = desktop.onObsLiveChanged(() => { void refresh(); });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [restart]);
  useEffect(() => {
    let active = true;
    let started = false;
    setError(null);
    const run = async (): Promise<void> => {
      try {
        while (active) {
          const frame = await desktop.getObsLiveFrame();
          if (!active) break;
          const target = canvas.current;
          const context = target?.getContext('2d', { alpha: false });
          if (!target || !context) throw new Error('无法创建 OBS 实时画布');
          if (target.width !== frame.width || target.height !== frame.height) { target.width = frame.width; target.height = frame.height; }
          context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
        }
      } catch (reason) { if (active) setError(String(reason)); }
    };
    liveSession = liveSession.then(async () => { if (active) { started = true; await run(); } });
    return () => { active = false; if (started) void desktop.closeObsLivePreview().catch((reason: unknown) => { console.error('关闭 OBS 预览失败', reason); }); };
  }, [restart]);
  const send = async (): Promise<void> => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (pending.current) { const next = pending.current; pending.current = null; await desktop.editObsLiveScene(next); }
      const next = obsLiveSceneSchema.parse(await desktop.readObsLiveScene());
      if (!editing.current) setScene(next);
    } catch (reason) { pending.current = null; editing.current = false; setError(String(reason)); }
    finally { sending.current = false; if (pending.current) void send(); }
  };
  const edit = (next: ObsLiveEdit, dragging: boolean): void => {
    editing.current = dragging;
    pending.current = next;
    void send();
  };
  return <div className="obs-live-container">
    <div className="obs-live-canvas" style={{ aspectRatio: scene ? `${scene.width} / ${scene.height}` : '16 / 9', width: `min(calc(100cqw - 40px), calc((100cqh - 40px) * ${scene ? scene.width / scene.height : 16 / 9}))` }}>
    <canvas ref={canvas} aria-label="OBS 实时画面" />
    {scene && !error ? <ObsLiveSelection scene={scene} selected={selected} onSelect={setSelected} onEdit={edit} /> : null}

    {error ? <div className="stage-error" role="alert">{error}<button onClick={() => setRestart((value) => value + 1)}>重新连接预览</button></div> : null}
    </div>
  </div>;
}
