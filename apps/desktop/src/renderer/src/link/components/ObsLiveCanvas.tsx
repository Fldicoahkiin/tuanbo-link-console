import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toUserErrorMessage } from '@tb/core/link';
import { obsLiveSceneSchema, type ObsLiveEdit, type ObsLiveItem, type ObsLiveScene } from '@tb/schema';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { ObsLiveSelection } from './ObsLiveSelection';
import { obsPreviewSession } from '../view-models/obs-preview-session';
import { LiveFramePainter, livePreviewRun, livePreviewWanted } from './obs-live-frames';

let liveSession: Promise<void> = Promise.resolve();

/** The editor's say over sources that are the picture of one of the song's materials (E16): `refuse` is asked before
 * a move starts (a reason stops it before anything reaches OBS), and `released` keeps the move the pointer let go of
 * in the project, so preparing the material sets it again from there. Other sources are edited in OBS as before. */
export type ObsLiveMaterialEdits = {
  refuse: (item: ObsLiveItem) => string | null;
  released: (item: ObsLiveItem, transform: ObsLiveItem['sceneItemTransform'], scene: ObsLiveScene) => void;
};

export const ObsLiveCanvas = memo(function ObsLiveCanvas({ editable = true, onAspectChange, material }: { editable?: boolean; onAspectChange?: (ratio: number) => void; material?: ObsLiveMaterialEdits }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scene, setScene] = useState<ObsLiveScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** Why a move of a material's picture was not kept (E16); its own line, so a refresh of the scene does not clear it. */
  const [materialError, setMaterialError] = useState<string | null>(null);
  const sceneName = useRef<string | null>(null);
  const active = useRef(true);
  const [selected, setSelected] = useState<number | null>(null);
  const pending = useRef<ObsLiveEdit | null>(null);
  const sending = useRef(false);
  const editing = useRef(false);
  const editRevision = useRef(0);
  const [restart, setRestart] = useState(0);
  const [repairing, setRepairing] = useState(false);
  const [suspended, setSuspended] = useState(false);
  const [visible, setVisible] = useState(false);
  const previewFailed = useRef(false);
  const [painter] = useState(() => new LiveFramePainter(() => canvas.current));
  useEffect(() => { active.current = true; return () => { active.current = false; pending.current = null; }; }, []);
  const acceptScene = useCallback((next: ObsLiveScene): void => {
    if (!active.current) return;
    const changed = sceneName.current !== next.sceneName;
    if (changed) { pending.current = null; editing.current = false; setSelected(null); setEditError(null); }
    sceneName.current = next.sceneName;
    if (changed || !editing.current && !sending.current) setScene(next);
  }, []);
  useEffect(() => { if (scene) onAspectChange?.(scene.width / scene.height); }, [scene, onAspectChange]);
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
      // Local transform events are reconciled once on release, not with a full
      // three-request scene read for every pointer move.
      if (editing.current || sending.current) return;
      if (busy) { dirty = true; return; }
      busy = true;
      const revision = editRevision.current;
      try { const next = obsLiveSceneSchema.parse(await desktop.readObsLiveScene()); if (active && revision === editRevision.current && !editing.current && !sending.current) acceptScene(next); }
      catch (reason) { if (active && revision === editRevision.current) setEditError(toUserErrorMessage(reason)); }
      finally { busy = false; if (dirty && active) { dirty = false; void refresh(); } }
    };
    const unsubscribe = desktop.onObsLiveChanged(() => { void refresh(); });
    void refresh();
    return () => { active = false; unsubscribe(); };
  }, [restart, suspended, visible, acceptScene]);
  useEffect(() => {
    if (!livePreviewWanted({ visible, suspended, failed: previewFailed.current })) return;
    let active = true;
    const preview = obsPreviewSession.open();
    setError(null);
    // Frames at a cap (obs-live-frames.ts): 30 a second, about 10 while the timeline moves, uncapped while a source is moved here.
    const frames = livePreviewRun(preview, {
      draw: (frame) => { if (active) painter.draw(frame); },
      editingCanvas: () => editing.current,
      failed: (reason) => { if (active) { previewFailed.current = true; setError(toUserErrorMessage(reason)); } }
    });
    liveSession = liveSession.then(async () => { if (active) await frames.run(); }).catch((reason: unknown) => { if (active) setError(toUserErrorMessage(reason)); console.error('OBS 预览会话失败', reason); });
    return () => { active = false; frames.stop(); void preview.close().catch((reason: unknown) => { console.error('关闭 OBS 预览失败', reason); }); };
  }, [restart, suspended, visible, painter]);
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
    let targetScene: string | null = null;
    try {
      while (active.current && pending.current) { const next = pending.current; pending.current = null; targetScene = next.sceneName; await desktop.editObsLiveScene(next); }
      if (active.current && !editing.current) {
        const revision = editRevision.current;
        const next = obsLiveSceneSchema.parse(await desktop.readObsLiveScene());
        if (active.current && revision === editRevision.current && !editing.current && !pending.current) { acceptScene(next); setScene(next); setEditError(null); }
      }
    } catch (reason) {
      pending.current = null; editing.current = false;
      if (!active.current) return;
      setEditError(toUserErrorMessage(reason));
      // Read the new target once; never retry the old write into another scene.
      const revision = editRevision.current;
      try {
        const next = obsLiveSceneSchema.parse(await desktop.readObsLiveScene());
        if (active.current && revision === editRevision.current) { acceptScene(next); setScene(next); if (next.sceneName !== targetScene) setEditError(null); }
      } catch (readError) { if (active.current && revision === editRevision.current) setEditError(toUserErrorMessage(readError)); }
      void desktop.recordLog({ level: 'warning', category: 'device', device: 'obs', message: 'OBS 画面编辑已停止，修改不会自动重发', details: { sceneName: targetScene, reason: toUserErrorMessage(reason) } }).catch(console.error);
    }
    finally { sending.current = false; if (pending.current) void send(); }
  };
  const edit = (next: ObsLiveEdit, dragging: boolean): void => {
    if (!active.current || next.sceneName !== sceneName.current) return;
    editRevision.current++;
    setEditError(null);
    editing.current = dragging;
    pending.current = next;
    void send();
  };
  return <div className="obs-live-container">
    <div className="obs-live-canvas" style={{ aspectRatio: scene ? `${scene.width} / ${scene.height}` : '16 / 9', width: `min(calc(100cqw - 40px), calc((100cqh - 40px) * ${scene ? scene.width / scene.height : 16 / 9}))` }}>
    <canvas ref={canvas} aria-label="OBS 实时画面" />
    {editable && scene && !error ? <ObsLiveSelection key={scene.sceneName} scene={scene} selected={selected} onSelect={setSelected} onEdit={edit}
      refuse={material ? (item) => { const reason = material.refuse(item); setMaterialError(reason); return reason; } : undefined}
      onReleased={material ? (item, transform) => { try { material.released(item, transform, scene); } catch (reason) { setMaterialError(toUserErrorMessage(reason)); } } : undefined} /> : null}
    {editError ? <div className="obs-edit-notice" role="status">{editError}<button onClick={() => { setEditError(null); setRestart(value => value + 1); }}>刷新编辑目标</button></div>
      : materialError ? <div className="obs-edit-notice" role="status">{materialError}<button onClick={() => setMaterialError(null)}>知道了</button></div> : null}

    {error || repairing ? <div className="stage-error" role="alert">{repairing ? '正在检查 OBS 组件。如果弹出 Windows 授权或重启 OBS 的提示，请按提示完成。' : error}<button disabled={repairing} onClick={() => { void repair(); }}>检查并修复组件</button><button disabled={repairing} onClick={() => { previewFailed.current = false; setSuspended(false); setRestart((value) => value + 1); }}>重新连接预览</button></div> : null}
    </div>
  </div>;
});
