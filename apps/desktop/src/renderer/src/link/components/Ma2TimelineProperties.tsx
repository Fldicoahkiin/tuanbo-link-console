import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { checkMa2TimelineStart, formatMtcStart, parseMtcStart } from '@tb/core/link';
import type { LinkProject, Ma2TimecodeRanges } from '@tb/schema';
import { changeMa2TimelineProperties, readMa2EditingRanges } from '../runtime/ma2-timeline-actions';
import { ma2TimelineRows, type Ma2TimelineRow } from '../view-models/ma2-timeline-list';
import { Button, Dialog, Field, Select, TextInput } from '../ui';
import '../ma2-cached-browser.css';

type Props = { project: LinkProject; targets: readonly number[]; onClose: () => void; onSaved: (message: string, warning?: string) => void };
type RangeRead = { state: 'loading' } | { state: 'failed'; reason: string } | { state: 'ready'; ranges: Ma2TimecodeRanges };
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function Ma2TimelineProperties({ project, targets, onClose, onSaved }: Props): JSX.Element {
  const [target, setTarget] = useState(targets[0]!);
  const [reading, setReading] = useState<RangeRead>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(() => ma2TimelineRows(project), [project]);
  const conflict = targets.length > 1;
  function refresh(): void { setReading({ state: 'loading' }); setAttempt(value => value + 1); }
  useEffect(() => {
    let active = true;
    void readMa2EditingRanges().then(ranges => {
      if (active) setReading({ state: 'ready', ranges });
    }, error => {
      if (active) setReading({ state: 'failed', reason: reasonOf(error) });
    });
    return () => { active = false; };
  }, [attempt]);
  const row = rows.find(value => value.target === target);
  return <Dialog title={conflict ? '修改重叠的 MTC 起始码' : '修改时间线'}
    description={conflict ? `Timecode ${targets.join(' 和 ')} 的时段重叠。选择要移动的时间线，输入新的起始码。` : `Timecode ${target} · 修改名称和起始码`}
    onClose={() => { if (!busy) onClose(); }}>
    {conflict ? <Field label="要移动的时间线" stacked>{props => <Select {...props} value={target} disabled={busy} onChange={event => setTarget(Number(event.target.value))}>
      {targets.map(number => <option key={number} value={number}>Timecode {number} · {rows.find(value => value.target === number)?.name || '未命名'}</option>)}
    </Select>}</Field> : null}
    {row ? <MtcForm key={target} project={project} row={row} conflict={conflict} reading={reading} refresh={refresh} busy={busy} setBusy={setBusy} onSaved={onSaved} />
      : <p role="status">工程里还没有这条时间线，请在灯光工作台刷新控台时间线。</p>}
  </Dialog>;
}

function MtcForm({ project, row, conflict, reading, refresh, busy, setBusy, onSaved }: {
  project: LinkProject; row: Ma2TimelineRow; conflict: boolean; reading: RangeRead; refresh: () => void;
  busy: boolean; setBusy: (value: boolean) => void; onSaved: (message: string, warning?: string) => void;
}): JSX.Element {
  const frameRate = project.timebase.frameRate;
  const remote = conflict && reading.state === 'ready' ? reading.ranges.entries.find(value => value.target === row.target) : undefined;
  const currentMs = remote ? Math.round(Number(remote.offset) * 1000 / 30) : row.startMs;
  const current = currentMs === null || !Number.isFinite(currentMs) ? '' : formatMtcStart(currentMs, frameRate);
  const [start, setStart] = useState(conflict ? '' : current);
  const [name, setName] = useState(row.name);
  const [error, setError] = useState('');
  let startMs: number | undefined;
  let valid = false;
  let unavailable = false;
  let hint = '请输入时、分、秒，例如 00:20:00 或 002000。';
  if (start.trim()) {
    try {
      startMs = start === current && currentMs !== null ? currentMs : parseMtcStart(start, frameRate);
      if (reading.state === 'ready') {
        checkMa2TimelineStart(project, reading.ranges, row.target, startMs);
        valid = true;
        hint = '可用，整段时间都空闲。';
      } else {
        hint = reading.state === 'loading' ? '正在读取控台时段…' : `暂时无法确认。 ${reading.reason}`;
      }
    } catch (cause) { unavailable = true; hint = `不可用。 ${reasonOf(cause)}`; }
  }
  const changed = startMs !== undefined && startMs !== currentMs;
  const renameOnly = !conflict && !changed && startMs !== undefined && name.trim() !== row.name;
  const canSave = !busy && (conflict || Boolean(name.trim())) && (renameOnly || changed && valid);
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSave || startMs === undefined) return;
    setBusy(true); setError('');
    try {
      const result = await changeMa2TimelineProperties(row.target, name || `Timecode ${row.target}`, startMs,
        { ...(changed && reading.state === 'ready' ? { ranges: reading.ranges } : {}), keepName: conflict || name === row.name });
      onSaved(result.message, result.warning);
    } catch (cause) { setError(reasonOf(cause)); refresh(); }
    finally { setBusy(false); }
  }
  return <form className="ma2-timeline-properties" onSubmit={event => void submit(event)}>
    {conflict ? <p>当前起始码　{current || '尚未读取'}</p> :
      <Field label="时间线名称" stacked>{props => <TextInput {...props} required disabled={busy} value={name} onChange={event => setName(event.target.value)} />}</Field>}
    <Field label={conflict ? '新的 MTC 起始码' : 'MTC 起始码'} stacked help={<span role="status" data-availability={unavailable ? 'unavailable' : valid ? 'available' : undefined}>{hint}</span>}>
      {props => <TextInput {...props} required autoFocus={conflict} disabled={busy} aria-invalid={unavailable} placeholder="00:00:00" value={start} onChange={event => { setStart(event.target.value); setError(''); }} />}
    </Field>
    {reading.state === 'failed' ? <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={refresh}>重新检查控台时段</Button> : null}
    {error ? <p role="alert">{error}</p> : null}
    <Button type="submit" variant="primary" disabled={!canSave}>{busy ? '正在保存并确认…' : renameOnly ? '保存名称' : '保存修改'}</Button>
  </form>;
}
