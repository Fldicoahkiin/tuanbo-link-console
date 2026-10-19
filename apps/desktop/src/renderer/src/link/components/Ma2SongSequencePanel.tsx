import { useEffect, useState } from 'react';
import { ma2SongPoints, setLightingCommand } from '@tb/core/link';
import type { Ma2LayoutSettings } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { startMa2SongSync, stopMa2SongSync, useMa2SongSyncStore } from '../runtime/ma2-song-sync';
import { locateMa2Executor, ma2ExecutorLocationLabel } from '../stores/ma2-executor-page-store';

export function Ma2SongSequencePanel({ itemId, settings }: { itemId: string; settings: Ma2LayoutSettings }): JSX.Element {
  const item = useDocumentStore(state => state.project?.rundown.find(value => value.id === itemId));
  const status = useMa2SongSyncStore(state => state.songs[itemId]);
  const binding = item?.lighting?.consoleSong;
  const [name, setName] = useState(binding?.name ?? item?.title ?? '歌曲序列');
  const [editingName, setEditingName] = useState(false);
  const [executorPage, setExecutorPage] = useState(binding?.executor ? Number(binding.executor.split('.')[0]) : settings.executorPage ?? 1000);
  useEffect(() => { if (!editingName && binding) setName(binding.name); }, [binding, editingName]);
  const [error, setError] = useState(''); const [review, setReview] = useState(false);
  const removed = binding?.points.filter(point => !item?.lighting?.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.id === point.id || event.effectGroupId === point.id)))) ?? [];
  const start = (confirmed = false): void => {
    try {
      if (!item?.lighting) throw new Error('请先添加时间线 Cue');
      const count = ma2SongPoints(item.lighting).length; if (!count) throw new Error('请先在时间线添加 Cue');
      startMa2SongSync(itemId, name.trim(), binding ? { ...settings, layout: binding.layout ?? settings.layout, executorPage: binding.executor ? Number(binding.executor.split('.')[0]) : undefined, nextSequence: binding.sequence } : { ...settings, executorPage }, confirmed ? removed.map(point => point.cue) : undefined); setError(''); setReview(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="ma2-song-panel" aria-label="本曲控台序列">
    <strong>本曲控台序列</strong>
    <p>{binding ? `${binding.executor ? ma2ExecutorLocationLabel(Number(binding.executor.split('.')[0]), Number(binding.executor.split('.')[1])) : `Layout ${binding.layout}`} · 序列 ${binding.sequence} · ${binding.points.length} 步` : `整首歌合为一条多步序列，放进按钮第 ${executorPage} 页的空格。可以在控台继续编灯。`}</p>
    {binding?.executor ? <button onClick={() => { const [page, slot] = binding.executor!.split('.').map(Number); locateMa2Executor(page!, slot!); }}>定位本曲控台位置</button> : !binding ? <label>按钮页<input aria-label="本曲按钮页" type="number" min={1} max={9999} value={executorPage} onChange={event => setExecutorPage(Number(event.target.value))}/></label> : null}
    <label>序列名称<input aria-label="本曲控台序列名称" value={name} onFocus={() => setEditingName(true)} onChange={event => setName(event.target.value)} onBlur={() => {
      setEditingName(false); if (!binding || !item?.lighting || name === binding.name) return;
      try { useDocumentStore.getState().execute(setLightingCommand(itemId, { ...item.lighting, consoleSong: { ...binding, name: name.trim() } }, '重命名歌曲控台序列')); setError(''); }
      catch (cause) { setError(String(cause)); }
    }}/></label>
    <div><button disabled={status?.state === 'syncing'} onClick={() => start()}>{binding ? status?.state === 'blocked' ? '重新核对并同步' : '开启本曲双向同步' : `创建到按钮第 ${executorPage} 页并同步`}</button>{status ? <button disabled={status.state === 'syncing'} onClick={() => stopMa2SongSync(itemId)}>暂停同步</button> : null}</div>
    {status ? <p role={status.state === 'blocked' ? 'alert' : 'status'}>{status.message}</p> : null}
    {removed.length ? <button onClick={() => setReview(!review)}>核对控台删除清单 · {removed.length} 项</button> : null}
    {review ? <div className="ma2-song-delete-review"><strong>将同时删除控台 Cue</strong><ul>{removed.map(point => <li key={point.id}>Sequence {binding?.sequence} · Cue {Number(point.cue)}</li>)}</ul><button onClick={() => start(true)}>确认清单并同步删除</button><button onClick={() => setReview(false)}>取消</button></div> : null}
    <p>停止播放时自动双向核对名称与 Cue 内容；两边同时修改会停下提示。控台新增 Cue 会显示在本页素材中，拖到时间线即可指定时间。</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
