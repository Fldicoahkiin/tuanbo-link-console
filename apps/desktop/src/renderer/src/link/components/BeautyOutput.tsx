import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { BeautyTarget } from '@tb/schema';
import { useBeautyStore } from '../stores/beauty-store';
import { useBeautyOutputState } from '../runtime/use-beauty-output';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { beautyFeedback } from '../view-models/beauty-feedback';

export function BeautyOutput({ connected, onTarget }: { connected: boolean; onTarget: (target: BeautyTarget | null) => void }): JSX.Element {
  const { confirmed, runtime, error } = useBeautyOutputState();
  const [installing, setInstalling] = useState(false);
  const [message, setMessage] = useState('');
  const source = runtime?.sourceName ?? '', filter = runtime?.filterName ?? '';
  const ready = connected && !!source && !!filter && !!confirmed?.enabled && confirmed.sourceName === source && confirmed.filterName === filter;
  useEffect(() => {
    onTarget(ready ? { sourceName: source, filterName: filter } : null);
  }, [ready, source, filter, onTarget]);
  const install = async (): Promise<void> => {
    setInstalling(true);
    try { setMessage(await desktop.installBeautyRuntime()); }
    catch (reason) { setMessage(String(reason)); }
    finally { setInstalling(false); }
  };
  return <section className="beauty-output" aria-label="全画面美颜状态">
    <p>对 OBS 的整个画面统一美颜，切换场景时自动跟随，不用选来源，也不用手动启动。</p>
    {source ? <p>当前画面：{source}</p> : null}
    {runtime?.phase === 'error' || error ? <>
      <p className="beauty-output-error" role="alert">{error || runtime?.message}</p>
      <button className="secondary-button" disabled={installing} onClick={() => { void install(); }}><Download size={15} />检查并安装组件</button>
    </> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}

/** Detection updates stay inside this small row instead of rerendering the workspace. */
export function BeautyStatus({ connected, onDetails }: { connected: boolean; onDetails: () => void }): JSX.Element {
  const { confirmed, runtime, error, busy } = useBeautyOutputState();
  const values = useBeautyStore(state => state.library.values);
  const feedback = beautyFeedback({ connected, source: runtime?.sourceName ?? '', filter: runtime?.filterName ?? '', confirmed, values, busy, error, runtime, runtimeError: '' });
  return <div className="beauty-feedback" data-tone={feedback.tone} role="status" aria-label="美颜生效状态">
    <span className="beauty-feedback-dot" /><span title={feedback.text}>{feedback.text}</span>
    {feedback.tone === 'error' ? <button onClick={onDetails}>查看详情</button> : null}
  </div>;
}
