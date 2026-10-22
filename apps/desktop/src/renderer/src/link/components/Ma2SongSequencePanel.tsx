import { useEffect, useState } from 'react';
import { ma2SongPoints, projectLightingLibrary, setLightingCommand, setLightingLibraryCommand } from '@tb/core/link';
import { ma2LayoutSettingsSchema, type Ma2LayoutSettings } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { startMa2SongSync, useMa2SongSyncStore } from '../runtime/ma2-song-sync';
import { pauseMa2RealtimeSession, retryMa2RealtimeSession } from '../runtime/ma2-realtime-session';
import { locateMa2Executor, ma2ExecutorLocationLabel } from '../stores/ma2-executor-page-store';
import { Ma2SongConflicts } from './Ma2SongConflicts';
import { Ma2ConsoleName } from './Ma2ConsoleName';

export function Ma2SongSequencePanel({ itemId, settings }: { itemId: string; settings: Ma2LayoutSettings }): JSX.Element {
  const item = useDocumentStore(state => state.project?.rundown.find(value => value.id === itemId));
  const status = useMa2SongSyncStore(state => state.songs[itemId]);
  const binding = item?.lighting?.consoleSong;
  const [name, setName] = useState(binding?.name ?? item?.title ?? '歌曲序列');
  const [editingName, setEditingName] = useState(false);
  const executorPage = settings.executorPage ?? 1000;
  const [pageDraft, setPageDraft] = useState(String(executorPage));
  const [defaultMessage, setDefaultMessage] = useState('');
  useEffect(() => { setPageDraft(String(executorPage)); }, [executorPage]);
  useEffect(() => { if (!editingName && binding) setName(binding.name); }, [binding, editingName]);
  const [error, setError] = useState(''); const [review, setReview] = useState(false);
  const saveDefaultPage = (): void => {
    setError(''); setDefaultMessage('');
    try {
      const page = Number(pageDraft);
      if (!Number.isInteger(page) || page < 1 || page > 9999) throw new Error('默认创建页请输入 1–9999 的整数');
      const before = useDocumentStore.getState();
      if (!before.project) throw new Error('请先打开工程');
      const library = projectLightingLibrary(before.project);
      if (library.consoleWorkspace?.executorPage !== page) {
        const workspace = ma2LayoutSettingsSchema.parse({ ...settings, ...library.consoleWorkspace, executorPage: page });
        before.execute(setLightingLibraryCommand({ ...library, consoleWorkspace: workspace }, '设置默认歌曲按钮页'));
      }
      setPageDraft(String(page)); setDefaultMessage(`默认第 ${page} 页，保存工程后写入工程文件`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const removed = binding?.points.filter(point => !item?.lighting?.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.id === point.id || event.effectGroupId === point.id)))) ?? [];
  const start = (confirmed = false): void => {
    try {
      if (!item?.lighting) throw new Error('请先添加时间线 Cue');
      const count = ma2SongPoints(item.lighting).length; if (!count && !binding) throw new Error('请先在时间线添加 Cue');
      startMa2SongSync(itemId, name.trim(), binding ? { ...settings, layout: binding.layout ?? settings.layout, executorPage: binding.executor ? Number(binding.executor.split('.')[0]) : undefined, nextSequence: binding.sequence } : { ...settings, executorPage }, confirmed ? removed.map(point => point.cue) : undefined);
      retryMa2RealtimeSession(); setError(''); setReview(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="ma2-song-panel" aria-label="本曲控台序列">
    <strong>本曲控台序列</strong>
    <p>{binding ? `${binding.executor ? ma2ExecutorLocationLabel(Number(binding.executor.split('.')[0]), Number(binding.executor.split('.')[1])) : `Layout ${binding.layout}`} · 序列 ${binding.sequence} · ${binding.points.length} 步` : `整首歌合为一条多步序列，放进按钮第 ${executorPage} 页的空格。可以在控台继续编灯。`}</p>
    {binding?.assignment === 'unassigned' ? <p>执行器已解除分配，序列 {binding.sequence} 和 Cue 内容保留。</p> : binding?.executor ? <button onClick={() => { const [page, slot] = binding.executor!.split('.').map(Number); locateMa2Executor(page!, slot!); }}>定位本曲控台位置</button> : null}
    <form className="ma2-song-default-page" noValidate onSubmit={event => { event.preventDefault(); saveDefaultPage(); }}>
      <label>默认创建页<input aria-label="默认创建按钮页" type="number" min={1} max={9999} step={1} value={pageDraft} onChange={event => { setPageDraft(event.target.value); setDefaultMessage(''); }}/></label>
      <button>保存默认</button>
      <small>{defaultMessage || '本工程后续新建歌曲使用此按钮页，已创建歌曲保持原位置。'}</small>
    </form>
    <label>序列名称<input aria-label="本曲控台序列名称" value={name} onFocus={() => setEditingName(true)} onChange={event => setName(event.target.value)} onBlur={() => {
      setEditingName(false); if (!binding || !item?.lighting || name === binding.name) return;
      try { useDocumentStore.getState().execute(setLightingCommand(itemId, { ...item.lighting, consoleSong: { ...binding, name: name.trim() } }, '重命名歌曲控台序列')); setError(''); }
      catch (cause) { setError(String(cause)); }
    }}/></label>
    <Ma2ConsoleName name={name}/>
    <div><button disabled={status?.state === 'syncing' || !binding && pageDraft !== String(executorPage)} title={!binding && pageDraft !== String(executorPage) ? '请先保存默认创建页' : undefined} onClick={() => start()}>{binding ? status?.state === 'blocked' ? '重新核对并同步' : '开启本曲双向同步' : `创建到按钮第 ${executorPage} 页并同步`}</button>{status ? <button onClick={pauseMa2RealtimeSession}>暂停同步</button> : null}</div>
    {status ? <p role={status.state === 'blocked' ? 'alert' : 'status'}>{status.message}</p> : null}
    <Ma2SongConflicts itemId={itemId} deletionChecklist={removed.map(point => point.cue)}/>
    {removed.length ? <button onClick={() => setReview(!review)}>核对控台删除清单 · {removed.length} 项</button> : null}
    {review ? <div className="ma2-song-delete-review"><strong>将同时删除控台 Cue</strong><ul>{removed.map(point => <li key={point.id}>Sequence {binding?.sequence} · Cue {Number(point.cue)}</li>)}</ul><button onClick={() => start(true)}>确认清单并同步删除</button><button onClick={() => setReview(false)}>取消</button></div> : null}
    <p>名称与 Cue 内容自动双向核对；同一项两边都改过时可选择保留哪边，其余修改继续同步。控台新增 Cue 可拖到时间线指定时间。</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
