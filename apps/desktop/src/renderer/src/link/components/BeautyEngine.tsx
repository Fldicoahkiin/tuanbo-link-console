import { useEffect, useRef, useState } from 'react';
import { Download, Play, Square } from 'lucide-react';
import { beautyRuntimeSchema, type BeautyRuntimeState, type BeautyTarget } from '@tb/schema';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

export function BeautyEngine({ source, connected, onReady, onStatus }: {
  source: string; connected: boolean; onReady: (target: BeautyTarget) => void;
  onStatus: (state: BeautyRuntimeState | null, error: string) => void;
}): JSX.Element {
  const [state, setState] = useState<BeautyRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pollFailed, setPollFailed] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const ready = useRef(onReady);
  ready.current = onReady;
  const status = useRef(onStatus);
  status.current = onStatus;
  useEffect(() => { status.current(state, error); }, [state, error]);
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    let announced = '';
    const read = async (): Promise<void> => {
      try {
        const next = beautyRuntimeSchema.parse(await desktop.readBeautyRuntime());
        if (cancelled) return;
        setState(next);
        if (next.sourceName && next.filterName && ['waiting', 'tracking'].includes(next.phase)) {
          const key = JSON.stringify([next.sourceName, next.filterName]);
          if (announced !== key) { announced = key; ready.current({ sourceName: next.sourceName, filterName: next.filterName }); }
        } else announced = '';
        timer = setTimeout(() => { void read(); }, 500);
      } catch (reason) {
        if (!cancelled) { setState(null); setPollFailed(true); setError(`无法读取美颜运行状态：${reason instanceof Error ? reason.message : String(reason)}`); }
      }
    };
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pollRevision]);
  const perform = async (action: 'install' | 'start' | 'stop'): Promise<void> => {
    setBusy(true); setError(''); setMessage('');
    try {
      if (action === 'install') setMessage(await desktop.installBeautyRuntime());
      else if (action === 'start') setState(beautyRuntimeSchema.parse(await desktop.startBeautyRuntime({ sourceName: source })));
      else { await desktop.stopBeautyRuntime(); setState(beautyRuntimeSchema.parse(await desktop.readBeautyRuntime())); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const running = state && ['starting', 'waiting', 'tracking'].includes(state.phase);
  return <div className="beauty-engine">
    <div className="beauty-output-actions">
      <button className="secondary-button" disabled={busy || !!running} onClick={() => { void perform('install'); }}><Download size={16} />安装组件</button>
      <button className="primary-button" disabled={busy || !connected || !source || !!running} onClick={() => { void perform('start'); }}><Play size={16} />启动美颜</button>
      <button className="secondary-button" disabled={busy || !state || state.phase === 'idle'} onClick={() => { void perform('stop'); }}><Square size={16} />停止</button>
    </div>
    <p role="status">{busy ? '正在处理…' : message || state?.message || '正在读取美颜状态…'}</p>
    {state?.phase === 'error' || error ? <p className="beauty-output-error" role="alert">{error || state?.message}</p> : null}
    {pollFailed ? <button className="secondary-button" onClick={() => { setError(''); setPollFailed(false); setPollRevision(value => value + 1); }}>重新读取美颜状态</button> : null}
  </div>;
}
