import { useEffect, useState } from 'react';
import { ma2SongPoints, projectLightingLibrary, setLightingCommand, setLightingLibraryCommand } from '@tb/core/link';
import { ma2LayoutSettingsSchema, type Ma2LayoutSettings } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { startMa2SongSync, useMa2SongSyncStore } from '../runtime/ma2-song-sync';
import { pauseMa2RealtimeSession, retryMa2RealtimeSession } from '../runtime/ma2-realtime-session';
import { locateMa2Executor, ma2ExecutorLocationLabel } from '../stores/ma2-executor-page-store';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import { SongMtcStart } from './SongMtcStart';

export function Ma2SongSequencePanel({ itemId, settings }: { itemId: string; settings: Ma2LayoutSettings }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const item = project?.rundown.find(value => value.id === itemId);
  const status = useMa2SongSyncStore(state => state.songs[itemId]);
  const binding = item?.lighting?.consoleSong;
  const [name, setName] = useState(binding?.name ?? item?.title ?? '歌曲序列');
  const [editingName, setEditingName] = useState(false);
  const executorPage = settings.executorPage ?? 1000;
  const [pageDraft, setPageDraft] = useState(String(executorPage));
  const [defaultMessage, setDefaultMessage] = useState('');
  useEffect(() => { setPageDraft(String(executorPage)); }, [executorPage]);
  useEffect(() => { if (!editingName && binding) setName(binding.name); }, [binding, editingName]);
  const [error, setError] = useState('');
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
  const start = (): void => {
    try {
      if (!item?.lighting) throw new Error('请先添加时间线 Cue');
      const count = ma2SongPoints(item.lighting).length; if (!count && !binding) throw new Error('请先在时间线添加 Cue');
      startMa2SongSync(itemId, name.trim(), binding ? { ...settings, layout: binding.layout ?? settings.layout, executorPage: binding.executor ? Number(binding.executor.split('.')[0]) : undefined, nextSequence: binding.sequence } : { ...settings, executorPage });
      retryMa2RealtimeSession(); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="ma2-song-panel" aria-label="本曲控台序列">
    <strong>本曲控台序列</strong>
    {project && item ? <SongMtcStart project={project} item={item} detail /> : null}
    <p>{binding ? `${binding.executor ? ma2ExecutorLocationLabel(Number(binding.executor.split('.')[0]), Number(binding.executor.split('.')[1])) : `Layout ${binding.layout}`} · 序列 ${binding.sequence} · ${binding.points.length} 步${binding.points.some(point => point.effectBpm !== undefined) ? ` · ${binding.points.filter(point => point.effectBpm !== undefined).length} 步设了效果速度` : ''}` : `整首歌合为一条多步序列，放进按钮第 ${executorPage} 页的空格。可以在控台继续编灯。`}</p>
    {binding?.assignment === 'unassigned' ? <p>执行器已解除分配；下次同步会把序列 {binding.sequence} 重新放回按钮第 {binding.executor?.split('.')[0]} 页。</p> : binding?.executor ? <button onClick={() => { const [page, slot] = binding.executor!.split('.').map(Number); locateMa2Executor(page!, slot!); }}>定位本曲控台位置</button> : null}
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
    <div><button disabled={status?.state === 'syncing' || !binding && pageDraft !== String(executorPage)} title={!binding && pageDraft !== String(executorPage) ? '请先保存默认创建页' : undefined} onClick={start}>{binding ? '刷新同步本曲' : `创建到按钮第 ${executorPage} 页并同步`}</button>{status ? <button onClick={pauseMa2RealtimeSession}>暂停同步</button> : null}</div>
    {status ? <p role={status.state === 'blocked' ? 'alert' : 'status'}>{status.message}</p> : null}
    <p>以时间线为准：时间线上加、改、删的 Cue 同样写到控台；在控台上删掉的 Cue 或整条序列会按上次确认的内容重建。控台上改的名称和新加的 Cue 会保留，新加的 Cue 可拖到时间线指定时间。</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
