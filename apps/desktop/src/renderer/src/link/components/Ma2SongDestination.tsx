import { useEffect, useState } from 'react';
import { projectLightingLibrary, setLightingLibraryCommand } from '@tb/core/link';
import { ma2LayoutSettingsSchema } from '@tb/schema';
import { ma2SongSyncSettings } from '../runtime/ma2-song-sync';
import { pendingSongSummary } from '../runtime/ma2-realtime-session';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { locateMa2Executor, ma2ExecutorLocationLabel } from '../stores/ma2-executor-page-store';
import { Button, Dialog, Field, TextInput } from '../ui';

/** The same creation defaults beside sync and in the song panel. Bound songs keep their location. */
export function Ma2SongDestination({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  const writing = useMa2SyncStore(state => Object.values(state.songs).some(song => song.state === 'syncing' || Boolean(song.requestId)));
  const saved = project ? projectLightingLibrary(project).consoleWorkspace : undefined;
  const page = saved?.executorPage ?? 1000, sequence = saved?.nextSequence ?? 9000;
  const [pageDraft, setPageDraft] = useState(String(page));
  const [sequenceDraft, setSequenceDraft] = useState(String(sequence));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setPageDraft(String(page)); }, [page]);
  useEffect(() => { setSequenceDraft(String(sequence)); }, [sequence]);
  useEffect(() => { onDirtyChange?.(pageDraft !== String(page) || sequenceDraft !== String(sequence)); }, [pageDraft, page, sequenceDraft, sequence, onDirtyChange]);
  if (!project) return null;
  const save = (): void => {
    setMessage(''); setError('');
    try {
      const executorPage = Number(pageDraft), nextSequence = Number(sequenceDraft);
      if (!Number.isInteger(executorPage) || executorPage < 1 || executorPage > 9999) throw new Error('默认创建页请输入 1–9999 的整数');
      if (!Number.isInteger(nextSequence) || nextSequence < 1 || nextSequence > 99999) throw new Error('起始序列编号请输入 1–99999 的整数');
      const current = useDocumentStore.getState();
      if (!current.project) throw new Error('请先打开工程');
      const library = projectLightingLibrary(current.project);
      const settings = ma2LayoutSettingsSchema.parse({ ...ma2SongSyncSettings(current.project), ...library.consoleWorkspace, executorPage, nextSequence });
      current.execute(setLightingLibraryCommand({ ...library, consoleWorkspace: settings }, '设置新歌控台位置'));
      setPageDraft(String(executorPage)); setSequenceDraft(String(nextSequence));
      setMessage(`已设置：按钮第 ${executorPage} 页，序列从 ${nextSequence} 开始找空号。保存工程后保留这些设置。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <form className="lighting-song-destination" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
    <Field label="新歌按钮页" stacked>{props => <TextInput {...props} aria-label="默认创建按钮页" type="number" min={1} max={9999} step={1} disabled={writing} value={pageDraft} onChange={event => { setPageDraft(event.target.value); setMessage(''); }} />}</Field>
    <Field label="起始序列编号" stacked>{props => <TextInput {...props} type="number" min={1} max={99999} step={1} disabled={writing} value={sequenceDraft} onChange={event => { setSequenceDraft(event.target.value); setMessage(''); }} />}</Field>
    <p>之后新建的多步 Cue 使用这里的位置。按钮放在 101–190 的空格，放满后用下一页；序列与 Timecode 同号，占用的编号会跳过。没填 MTC 起始码时，同步会先分配。已有歌曲继续同步到原位置。</p>
    <Button type="submit" variant="secondary" size="sm" disabled={writing}>保存默认</Button>
    {message ? <p role="status">{message}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}

export function Ma2SongDestinationDialog({ onClose }: { onClose: () => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  if (!project) return null;
  return <Dialog title="控台写入位置" description="先选择新歌的创建位置。同步确认后，可以在这里找到多步 Cue 实际使用的位置。" onClose={onClose}>
    <Ma2SongDestination key={project.projectId} />
    <div className="lighting-song-locations">
      {pendingSongSummary(project).map(item => <p key={item.itemId}>{item.title} · {item.count} 个 Cue · 待创建到按钮第 {item.page} 页</p>)}
      {project.rundown.map(item => {
        const binding = item.lighting?.consoleSong;
        if (!binding) return null;
        const [page, slot] = binding.executor?.split('.').map(Number) ?? [];
        return <div key={item.id}><p>{item.title}：{page && slot ? ma2ExecutorLocationLabel(page, slot) : `Layout ${binding.layout}`} · 序列 {binding.sequence} · {binding.timecode ? `Timecode ${binding.timecode.number}` : '时间码节目还没写入'} · {binding.points.length} 步</p>
          {page && slot ? <Button variant="secondary" size="sm" onClick={() => { locateMa2Executor(page, slot); onClose(); }}>定位「{item.title}」</Button> : null}
        </div>;
      })}
    </div>
  </Dialog>;
}
