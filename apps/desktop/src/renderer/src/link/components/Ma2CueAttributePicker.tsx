import { useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import type { Ma2CueAttributesRequest, Ma2CueValueEdit, Ma2CueValueRow } from '@tb/schema';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { Button } from '../ui';

export type UseConsoleCue = (sequence: number, cue: string, name: string, executor: string, attributes?: string[], includeTracking?: boolean, edits?: Ma2CueValueEdit[], editCurrent?: boolean) => void;

export type CueAttributeEditor = { programEdits: () => Ma2CueValueEdit[] | undefined };

type Props = {
  editorRef: Ref<CueAttributeEditor>;
  name: string; sequence: number; cue: string; directory: Ma2CueAttributesRequest['expectedSource'] | undefined;
  includeTracking: boolean; selection: string[] | undefined; initialEdits?: Ma2CueValueEdit[] | undefined;
  onChange: (names: string[] | undefined) => void; onAdd: (edits?: Ma2CueValueEdit[], editCurrent?: boolean) => void;
  composing: boolean; disabled: boolean;
};
type Scope = 'program' | 'original';

export function Ma2CueAttributePicker({ editorRef, name, sequence, cue, directory, includeTracking, selection, initialEdits, onChange, onAdd, composing, disabled }: Props): JSX.Element {
  const [rows, setRows] = useState<Ma2CueValueRow[]>();
  const [scope, setScope] = useState<Scope>('program');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState('');
  const [limit, setLimit] = useState(32);
  const otherDraft = useRef<Map<string, string>>(new Map());
  const [draft, setDraft] = useState<Map<string, string>>(() => new Map());
  const saved = useMemo(() => new Map((scope === 'program' ? initialEdits : undefined)?.map(edit => [edit.key, edit])), [scope, initialEdits]);
  const groups = useMemo(() => {
    const result = new Map<string, Ma2CueValueRow[]>();
    for (const row of rows ?? []) {
      const group = result.get(row.attribute);
      if (group) group.push(row); else result.set(row.attribute, [row]);
    }
    return result;
  }, [rows]);
  const valueOf = (row: Ma2CueValueRow): string => draft.get(row.key) ?? saved.get(row.key)?.value.toString() ?? row.value;
  const readRequest = async (target: Scope): Promise<Ma2CueAttributesRequest> => {
    if (!directory) throw new Error('请先连接并读取控台素材');
    const { show, generation, version } = directory;
    return { ...await ma2MaterialConnection(true), expectedSource: { show, generation, version }, sequence, cue, includeTracking: target === 'program' && includeTracking };
  };
  const read = async (target = scope): Promise<void> => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const values = await window.tbLink.readMa2CueValues(await readRequest(target));
      setRows(values);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; setBusy(false); }
  };
  function changeScope(next: Scope): void {
    setScope(next); setDraft(otherDraft.current); otherDraft.current = draft;
    setMessage(''); setError('');
    if (includeTracking && rows) { setRows(undefined); void read(next); }
  }
  const collectEdits = (): Ma2CueValueEdit[] => {
      if (!rows) return scope === 'program' ? initialEdits ?? [] : [];
      const edits: Ma2CueValueEdit[] = [];
      for (const row of rows ?? []) {
        if (scope === 'program' && selection && !selection.includes(row.attribute)) continue;
        const text = valueOf(row);
        if (!draft.has(row.key) && !saved.has(row.key)) continue;
        const value = Number(text);
        if (!text.trim() || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`${row.fixture} 的 ${row.attribute} 请输入 0 到 100 之间的数值`);
        if (value !== Number(row.value)) edits.push({ key: row.key, before: Number(row.value), value });
      }
      return edits;
  };
  useImperativeHandle(editorRef, () => ({
    programEdits() {
      if (scope === 'original') return initialEdits;
      const edits = collectEdits();
      return edits.length ? edits : undefined;
    }
  }));
  const apply = async (): Promise<void> => {
    if (running.current) return;
    setError(''); setMessage('');
    try {
      const edits = collectEdits();
      if (scope === 'program') { onAdd(edits.length ? edits : undefined, draft.size > 0); return; }
      if (!edits.length) return;
      running.current = true; setBusy(true);
      const receipt = await window.tbLink.writeMa2CueValues({ ...await readRequest(scope), edits });
      const applied = new Map(receipt.map(edit => [edit.key, edit.value.toString()]));
      setRows(previous => previous?.map(row => applied.has(row.key) ? { ...row, value: applied.get(row.key)!, preset: '' } : row));
      setDraft(new Map()); setMessage('控台已确认原 Cue 的数值');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; setBusy(false); }
  };
  return <aside className="ma2-cue-attribute-picker" aria-label="当前 Cue 属性">
    <strong>{name}</strong><small>序列 {sequence} · Cue {Number(cue)}</small>
    <span>{selection ? `已选 ${selection.length} 项属性` : '全部属性'}</span>
    {rows === undefined ? <Button variant="secondary" size="sm" disabled={!directory || busy} onClick={() => void read()}>{busy ? '正在读取属性…' : '读取属性'}</Button>
      : groups.size ? <>
        <label>修改范围<select value={scope} disabled={busy} onChange={e => changeScope(e.currentTarget.value === 'original' ? 'original' : 'program')}>
          <option value="program">仅当前节目</option><option value="original">修改控台原 Cue</option></select></label>
        {scope === 'original' && <small>引用这个原 Cue 的节目都会使用新数值。</small>}
        <fieldset disabled={busy} aria-label="选择灯光属性">{[...groups].map(([attribute, members]) => {
          const first = valueOf(members[0]!);
          const summary = members.every(row => valueOf(row) === first) ? first : '多个数值';
          return <div key={attribute}><div className="ma2-attribute-heading">
            {scope === 'program' && <input type="checkbox" aria-label={`选择 ${attribute}`} checked={!selection || selection.includes(attribute)} onChange={event => {
              const checked = event.currentTarget.checked;
              const chosen = [...groups.keys()].filter(key => key === attribute ? checked : !selection || selection.includes(key));
              onChange(chosen.length === groups.size ? undefined : chosen);
            }}/>}
            <button aria-expanded={expanded === attribute} onClick={() => { setExpanded(expanded === attribute ? '' : attribute); setLimit(32); }}>{attribute} · {summary}</button>
          </div>{expanded === attribute && <>
            {members.slice(0, limit).map((row, index) => <label key={row.key + '/' + index} className="ma2-fixture-value">
              <span>{row.fixture}{row.preset && <small>预设 {row.preset} · 修改后使用固定值</small>}</span>
              {row.value.trim() && Number.isFinite(Number(row.value)) ? <input type="number" step="any" min="0" max="100" value={valueOf(row)} aria-label={`${row.fixture} ${attribute}`} onChange={event => {
                const value = event.currentTarget.value;
                setDraft(current => new Map(current).set(row.key, value)); setMessage('');
              }}/> : <span>{row.value}</span>}
            </label>)}
            {members.length > limit && <Button size="sm" variant="ghost" onClick={() => setLimit(limit + 32)}>显示更多灯具</Button>}
          </>}</div>;
        })}</fieldset>
      </> : <small>这个 Cue 没有记录灯具属性</small>}
    {scope === 'program' && selection && <Button variant="ghost" size="sm" onClick={() => onChange(undefined)}>全选</Button>}
    {error && <small role="alert">{error}</small>}{message && <small role="status">{message}</small>}
    <Button size="sm" disabled={busy || disabled || (scope === 'original' ? !draft.size : selection?.length === 0)} onClick={() => void apply()}>
      {scope === 'original' ? '写入控台原 Cue' : draft.size && composing ? '应用到当前 Cue' : composing ? '加入当前 Cue' : '添加到播放头'}</Button>
  </aside>;
}
