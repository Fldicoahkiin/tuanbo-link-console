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
  const [repairing, setRepairing] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [visible, setVisible] = useState(false);
  const previewFailed = useRef(false);
  useEffect(() => {
    let active = true, received = false;
    const unsubscribe = desktop.onWindowVisibilityChanged((value) => { received = true; setVisible(value); });
    void desktop.getWindowVisible().then((value) => {
      if (typeof value !== 'boolean') throw new Error('窗口可见状态无效');
      if (active && !received) setVisible(value);
    }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (suspended || !visible) return;
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
  }, [restart, suspended, visible]);
  useEffect(() => {
    if (suspended || !visible) return;
    let active = true;
    let started = false;
    if (previewFailed.current) return;
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
          if (!(frame.rgba.buffer instanceof ArrayBuffer)) throw new Error('OBS 视频帧缓冲区类型无效');
          const pixels = new Uint8ClampedArray(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength);
          context.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
        }
      } catch (reason) { if (active) { previewFailed.current = true; setError(String(reason)); } }
    };
    liveSession = liveSession.then(async () => { if (active) { started = true; await run(); } });
    return () => { active = false; if (started) void desktop.closeObsLivePreview().catch((reason: unknown) => { console.error('关闭 OBS 预览失败', reason); }); };
  }, [restart, suspended, visible]);
  const repair = async (): Promise<void> => {
    if (repairing) return;
    setRepairing(true);
    setSuspended(true);
    try {
      await desktop.closeObsLivePreview();
      await desktop.repairObsBridge();
      previewFailed.current = false;
      setError(null);
      setSuspended(false);
      setRestart((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRepairing(false); }
  };
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

    {error || repairing ? <div className="stage-error" role="alert">{repairing ? '正在检查 OBS 组件，请完成可能出现的 Windows 授权或 OBS 重启确认。' : error}<button disabled={repairing} onClick={() => { void repair(); }}>检查并修复组件</button><button disabled={repairing} onClick={() => { previewFailed.current = false; setSuspended(false); setRestart((value) => value + 1); }}>重新连接预览</button></div> : null}
    </div>
  </div>;
}
