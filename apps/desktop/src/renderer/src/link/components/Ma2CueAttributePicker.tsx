import { useState } from 'react';
import type { Ma2CueAttributesRequest } from '@tb/schema';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { Button } from '../ui';

export type UseConsoleCue = (sequence: number, cue: string, name: string, executor: string, attributes?: string[], includeTracking?: boolean) => void;

export function Ma2CueAttributePicker({ name, sequence, cue, directory, includeTracking, selection, onChange, onAdd, composing, disabled }: {
  name: string; sequence: number; cue: string; directory: Ma2CueAttributesRequest['expectedSource'] | undefined;
  includeTracking: boolean; selection: string[] | undefined; onChange: (names: string[] | undefined) => void;
  onAdd: () => void; composing: boolean; disabled: boolean;
}): JSX.Element {
  const [names, setNames] = useState<string[]>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const read = async (): Promise<void> => {
    if (!directory || reading) return;
    setReading(true);
    setError('');
    try {
      if (typeof window.tbLink.readMa2CueAttributeNames !== 'function') {
        throw new Error('桌面程序需要重新启动才能读取属性。请保存工程，退出后重新打开。');
      }
      const { show, generation, version } = directory;
      const connection = await ma2MaterialConnection(true);
      setNames(await window.tbLink.readMa2CueAttributeNames({
        ...connection, expectedSource: { show, generation, version }, sequence, cue, includeTracking
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReading(false);
    }
  };
  const toggle = (attribute: string, checked: boolean): void => {
    if (!names) return;
    const chosen = names.filter(value => value === attribute ? checked : !selection || selection.includes(value));
    onChange(chosen.length === names.length ? undefined : chosen);
  };
  return <aside className="ma2-cue-attribute-picker" aria-label="当前 Cue 属性">
    <strong>{name}</strong><small>序列 {sequence} · Cue {Number(cue)}</small>
    <span>{selection ? `已选 ${selection.length} 项属性` : '全部属性'}</span>
    {names === undefined ? <Button variant="secondary" size="sm" disabled={!directory || reading} onClick={() => void read()}>{reading ? '正在读取属性…' : '读取属性'}</Button>
      : names.length ? <fieldset aria-label="选择灯光属性">{names.map(attribute =>
        <label key={attribute}><input type="checkbox" checked={!selection || selection.includes(attribute)} onChange={event => toggle(attribute, event.currentTarget.checked)}/>{attribute}</label>)}</fieldset>
      : <small>这个 Cue 没有记录灯具属性</small>}
    {selection && <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>全选</Button>}
    {error && <small role="alert">{error}</small>}
    <Button size="sm" disabled={disabled || selection?.length === 0} onClick={onAdd}>{composing ? '加入当前 Cue' : '添加到播放头'}</Button>
  </aside>;
}
