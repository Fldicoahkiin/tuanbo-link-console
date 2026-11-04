import { useState } from 'react';
import { MapPin, RefreshCw } from 'lucide-react';
import { Button } from '../ui';
import { Ma2MaterialMenu } from './Ma2MaterialMenu';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { locateMa2Executor, ma2ExecutorLocationLabel, ma2SequenceLocations, scanMa2ExecutorLocations, useMa2ExecutorPageStore } from '../stores/ma2-executor-page-store';

export function Ma2CueLocations({ sequence }: { sequence: number }): JSX.Element {
  const state = useMa2ExecutorPageStore(); const [open, setOpen] = useState(false); const [error, setError] = useState('');
  const current = state.scope === currentMa2LayoutScope();
  const locations = current ? ma2SequenceLocations(state.pages, sequence) : [];
  const complete = current && state.complete;
  const read = (): void => { setError(''); void scanMa2ExecutorLocations().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); };
  return <Ma2MaterialMenu label="Cue 控台位置" title={locations.length ? '查看这个序列所在的全部执行器页面' : complete ? '这个序列还没放进执行器页面' : '查找这个序列在执行器页面上的位置'} menuLabel="Cue 控台位置列表" open={open} onOpenChange={value => { setOpen(value); if (value && !complete && !state.scanning) read(); }} trigger={<><MapPin/>{locations[0] ? <span>{ma2ExecutorLocationLabel(locations[0].page, locations[0].slot) + (locations.length > 1 ? ` +${locations.length - 1}` : '')}</span> : null}</>}>
      {locations.map(location => <Button key={`${location.page}.${location.slot}`} variant="ghost" size="sm" icon={MapPin} onClick={() => { locateMa2Executor(location.page, location.slot); setOpen(false); }}>{ma2ExecutorLocationLabel(location.page, location.slot)}</Button>)}
      {state.scanning ? <p role="status">正在读取位置 {state.completed}/{state.total || '…'} 页</p> : !complete ? <Button variant="ghost" size="sm" icon={RefreshCw} onClick={read}>读取全部位置</Button> : !locations.length ? <p>序列 {sequence} 还没放到执行器页面，可以在序列池里找到。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
  </Ma2MaterialMenu>;
}
