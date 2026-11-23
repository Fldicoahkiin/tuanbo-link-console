import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Square } from 'lucide-react';
import type { Ma2AuditionState } from '@tb/schema';
import { Button, Popover } from '../ui';
import { acknowledgeClosedMa2Audition, observeMa2Audition, stopMa2Audition, useMa2AuditionStore } from '../stores/ma2-audition-store';

function StopDetails({ failure, targets }: { failure: string; targets: Ma2AuditionState['targets'] }): JSX.Element {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return <>
    <Button className="lighting-stop-details-toggle" size="sm" variant="ghost" aria-expanded={Boolean(anchor)} aria-haspopup="dialog"
      onClick={event => setAnchor(anchor ? null : event.currentTarget)}>
      {targets.length ? `未确认停止 · ${targets.length} 个目标` : '未确认停止'}
    </Button>
    {anchor && <Popover anchor={anchor} label="控台停止详情" placement="below-start" className="lighting-stop-details" onClose={close}>
      {failure && <p>{failure}</p>}
      {targets.map(target => <div key={target.id}>
        <p>{target.network.host} · {target.action.target === 'sequence' ? `序列 ${target.action.sequence}` : `执行器 ${target.action.executor}`} · {target.error || '请在控台确认是否停止'}</p>
        {target.connectionChanged && <Button size="sm" variant="secondary" onClick={() => { void acknowledgeClosedMa2Audition(target.id); }}>确认原控台</Button>}
      </div>)}
    </Popover>}
  </>;
}

export function LightingAuditionStop(): JSX.Element {
  const { state, error } = useMa2AuditionStore();
  useEffect(observeMa2Audition, []);
  const stopping = state.phase === 'stopping';
  const targets = state.targets.filter(target => target.state === 'failed');
  const failure = state.consoleStopError || (state.phase === 'failed' ? error || (targets.length ? '' : '还没收到停止结果，请在控台确认或再按一次停止') : '');
  return <div className="lighting-audition-control">
    <Button className="lighting-stop-audition" data-phase={state.phase} title={stopping ? '正在停止控台 Cue' : '停止整台控台上正在运行的 Cue'}
      aria-label="停止全部控台 Cue" aria-busy={stopping} disabled={stopping}
      onClick={() => { void stopMa2Audition('stop-console').catch((cause: unknown) => console.error('停止控台 Cue 失败', cause)); }}>
      {stopping ? <LoaderCircle size={16}/> : <Square size={16} fill="currentColor"/>}
    </Button>
    {!stopping && (failure || targets.length > 0) && <StopDetails failure={failure} targets={targets}/>}
  </div>;
}
