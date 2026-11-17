import { useState } from 'react';
import { formatMtcStart, newMa2TimelineCommand, parseMtcStart, programTimeOrigin } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { ma2SongSyncSettings, stopMa2SongSync } from '../runtime/ma2-song-sync';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
import { currentShowWait } from '../stores/show-state-store';
import { syncMa2Once } from '../runtime/ma2-realtime-session';
import { Button, Field, TextInput } from '../ui';

export function Ma2SequenceTimeline({ itemId, disabled, notify }: { itemId: string; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  const item = project?.rundown.find(value => value.id === itemId);
  const [name, setName] = useState(item?.title ?? '');
  const [start, setStart] = useState(() => { try { return project && item ? formatMtcStart(programTimeOrigin(item), project.timebase.frameRate) : '00:00:00'; } catch { return ''; } });
  const defaults = project ? ma2SongSyncSettings(project, itemId) : null;
  const [timecode, setTimecode] = useState(String(defaults?.nextSequence ?? 9000));
  const [sequence, setSequence] = useState(String(defaults?.nextSequence ?? 9000));
  const [executor, setExecutor] = useState(`${defaults?.executorPage ?? 1000}.101`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!project || !item) return null;
  const create = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      const before = useDocumentStore.getState();
      if (!before.project || before.project !== project) throw new Error('工程已改变，请重新创建');
      const blocked = (): string | null => {
        const sync = useMa2SyncStore.getState().songs[itemId];
        return sync?.requestId || sync?.checking || sync?.writing ? '当前节目正在同步，请等待完成' : currentShowWait('ma2.sync.write');
      };
      const wait = blocked(); if (wait) throw new Error(wait);
      const command = newMa2TimelineCommand(itemId, { name: name.trim(), timecode: Number(timecode), sequence: Number(sequence), executor }, parseMtcStart(start, project.timebase.frameRate));
      command.execute(project);
      if (item.lighting && (item.lighting.tracks.length || item.lighting.consoleSong || item.lighting.ma2Bindings?.length)) {
        if (!await archiveMa2Project(before.documentId, project, 'manual')) throw new Error('原编排未能存档，未创建新时间线');
      }
      const latest = useDocumentStore.getState();
      if (latest.project !== project || latest.documentId !== before.documentId) throw new Error('存档期间工程有变化，请重新创建');
      const waiting = blocked(); if (waiting) throw new Error(waiting);
      stopMa2SongSync(itemId);
      latest.execute(command);
      syncMa2Once(itemId);
      const actual = useDocumentStore.getState().project?.rundown.find(song => song.id === itemId)?.lighting?.timelineDestination;
      notify(`已保存「${name.trim()}」，正在请求控台创建 Timecode ${actual?.timecode ?? timecode}、序列 ${actual?.sequence ?? sequence}、执行器 ${actual?.executor ?? executor}。创建结果会显示在当前页。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <form className="ma2-sequence-create" onSubmit={event => { event.preventDefault(); void create(); }}>
    <h4>新建一条空时间线</h4><p>填写名称、MTC 和起始位置。Cue 会同步为控台上的多步序列。</p>
    <div className="ma2-sequence-fields">
      <Field label="时间线名称" stacked>{props => <TextInput {...props} required value={name} disabled={disabled || busy} onChange={event => setName(event.target.value)} />}</Field>
      <Field label="MTC 起始码" stacked>{props => <TextInput {...props} required placeholder="00:00:00" value={start} disabled={disabled || busy} onChange={event => setStart(event.target.value)} />}</Field>
      <Field label="Timecode 编号" stacked>{props => <TextInput {...props} required type="number" min="1" max="99999" value={timecode} disabled={disabled || busy} onChange={event => setTimecode(event.target.value)} />}</Field>
      <Field label="多步 Cue 序列编号" stacked>{props => <TextInput {...props} required type="number" min="1" max="99999" value={sequence} disabled={disabled || busy} onChange={event => setSequence(event.target.value)} />}</Field>
      <Field label="执行器位置（页.格）" stacked>{props => <TextInput {...props} required placeholder="1000.101" value={executor} disabled={disabled || busy} onChange={event => setExecutor(event.target.value)} />}</Field>
    </div>
    <p>创建后使用新的空编排，原编排先存档，控台原位置保留。位置已占用时自动向后顺延，实际位置显示在列表中。点击新建即创建空时间线，后续 Cue 写回同一位置。</p>
    <Button type="submit" variant="primary" disabled={disabled || busy || !item.referenceAudio}>{busy ? '正在存档并创建…' : '新建时间线'}</Button>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
