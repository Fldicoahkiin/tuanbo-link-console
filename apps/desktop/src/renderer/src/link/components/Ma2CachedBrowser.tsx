import { useState } from 'react';
import { refreshMa2BindingCommand, detachMa2BindingCommand, restoreMa2BindingCommand, confirmMa2PairingCommand, formatMtcOffset, matchMa2Programs, programTimeOrigin } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, updateMa2ReadState } from '../stores/ma2-read-store';
import { useSelectedProgram } from '../useSelectedProgram';
import '../ma2-cached-browser.css';

function mtcText(item: Parameters<typeof programTimeOrigin>[0], frameRate: Parameters<typeof formatMtcOffset>[1]): string {
  try { return formatMtcOffset(programTimeOrigin(item), frameRate); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}

export function Ma2CachedBrowser({ disabled, onClose, notify }: { disabled: boolean; onClose: () => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const [, selectSong] = useSelectedProgram(notify);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const cache = project?.ma2ReadState;
  if (!project || !cache) return <section className="ma2-cached-browser"><header><h3>控台时间线</h3><button onClick={onClose}>返回编辑</button></header><p>请先在“设置 → MA2 控台”里读取一次。目录、Cue 和配对会保存在当前工程里。</p></section>;
  const bindings = new Map(project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).map(binding => [binding.timecode, { item, binding }] as const)));
  const status = (target: number): string => {
    const entry = cache.catalog.entries.find(value => value.target === target);
    if (!entry || entry.error) return '读取异常';
    if (cache.pairings?.[target]?.status === 'stale') return '需要重新确认配对';
    if (entry.conversionError || cache.failures.some(value => value.target === target)) return '需处理';
    return `${bindings.has(target) ? '已配对' : '已读取'} · ${entry.preview?.unconverted.length ? '控台原样' : '可编辑'}`;
  };
  const rows = cache.catalog.entries.filter(entry => `${entry.target} ${entry.name} ${bindings.get(entry.target)?.item.title ?? ''}`.toLowerCase().includes(cache.query.toLowerCase()) &&
    (cache.filter === 'all' || cache.filter === 'pending' && (!bindings.has(entry.target) || cache.pairings?.[entry.target]?.status === 'stale') || cache.filter === 'native' && Boolean(entry.preview?.unconverted.length) || cache.filter === 'error' && Boolean(entry.error || entry.conversionError || cache.failures.some(value => value.target === entry.target))));
  const entry = rows.find(value => value.target === cache.selectedTarget) ?? rows[0];
  const bound = entry ? bindings.get(entry.target) : undefined;
  const paired = entry ? project.rundown.find(item => item.id === (cache.pairings?.[entry.target]?.itemId ?? cache.pairs[entry.target])) : undefined;
  const song = bound?.item ?? paired;
  let origin: number | undefined;
  let originError = '';
  try { if (song) origin = programTimeOrigin(song); }
  catch (error) { originError = error instanceof Error ? error.message : String(error); }
  const frameRate = project.timebase.frameRate;
  const apply = async (target?: number): Promise<void> => {
    setBusy(true);
    try { await importCachedMa2(target); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  // Choosing the song is the pairing: its Cues land on that song's timeline in the same step.
  const pair = async (target: number, itemId: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await importCachedMa2(target, itemId);
      const title = project.rundown.find(item => item.id === itemId)?.title ?? '歌曲';
      if (result.imported.includes(itemId)) { selectSong(itemId); notify(`Timecode ${target} 的 Cue 已放到「${title}」的时间线`); }
      else notify(result.failures.find(failure => failure.target === target)?.message ?? `Timecode ${target} 未能放到「${title}」的时间线`, 'error');
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const confirm = (target: number, itemId: string): void => {
    try { useDocumentStore.getState().execute(confirmMa2PairingCommand(target, itemId)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const refresh = (itemId: string, target: number, archiveLocalEdits = false): void => {
    try { useDocumentStore.getState().execute(refreshMa2BindingCommand(itemId, target, archiveLocalEdits)); setConflict(null); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes('本地编排已有修改')) setConflict(target); notify(message, 'error'); }
  };
  const archive = (restore: boolean, itemId: string, target: number): void => {
    try { useDocumentStore.getState().execute((restore ? restoreMa2BindingCommand : detachMa2BindingCommand)(itemId, target)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const unresolved = entry ? matchMa2Programs(project, cache.catalog).unresolved.find(value => value.target === entry.target) : undefined;
  return <section className="ma2-cached-browser" aria-label="控台时间线与歌曲配对">
    <header><div><h3>控台时间线</h3><small>工程缓存 · {cache.source} · {cache.catalog.directory.show} · {new Date(cache.catalog.readAt).toLocaleString()} · 不是实时状态</small></div><button onClick={onClose}>返回编辑</button></header>
    <div className="ma2-browser-tools"><input aria-label="筛选控台时间线" value={cache.query} placeholder="搜索时间线或已配对歌曲" onChange={event => updateMa2ReadState({ query: event.target.value })} />
      <select aria-label="时间线状态筛选" value={cache.filter} onChange={event => { const filter = event.target.value; if (filter === 'all' || filter === 'pending' || filter === 'native' || filter === 'error') updateMa2ReadState({ filter }); }}><option value="all">全部</option><option value="pending">待配对</option><option value="native">控台原样</option><option value="error">需处理</option></select>
      <button disabled={disabled || busy} onClick={() => void apply()}>关联当前配对</button><span role="status">{cache.message}</span></div>
    <div className="ma2-browser-body"><nav aria-label="已读取时间线">{rows.map(row => <button key={row.target} aria-pressed={row.target === entry?.target} onClick={() => { updateMa2ReadState({ selectedTarget: row.target }); const linked = bindings.get(row.target); if (linked) selectSong(linked.item.id); }}><strong>{row.target} · {row.name}</strong><span>{status(row.target)} · {row.eventCount ?? '未知'} 个事件</span><small>{bindings.get(row.target)?.item.title ?? '还没关联歌曲'}</small></button>)}</nav>
      {entry ? <article><h4>Timecode {entry.target} · {entry.name}</h4><p>{status(entry.target)} · {entry.frameFormat} · 节目起点 <strong className="ma2-browser-mtc">MTC {/^\d+(?:\.\d+)?$/.test(entry.offset ?? '0') ? formatMtcOffset(Number(entry.offset ?? 0) * 1000 / 30, frameRate) : entry.offset}</strong> · {entry.slot}</p>
        {entry.error || entry.conversionError || originError ? <p role="alert">{entry.error ?? entry.conversionError ?? originError}</p> : null}
        {bound ? <div className="ma2-browser-tools"><strong>{bound.item.title}</strong>{cache.pairings?.[entry.target]?.status === 'stale' ? <><span role="alert">{cache.pairings[entry.target]?.reason}</span><button disabled={disabled || busy} onClick={() => confirm(entry.target, bound.item.id)}>确认这首歌</button></> : null}<button onClick={() => { selectSong(bound.item.id); onClose(); }}>查看歌曲 Cue 与音频</button><button disabled={disabled || busy} onClick={() => refresh(bound.item.id, entry.target)}>用已读取的内容刷新</button><button disabled={disabled || busy} onClick={() => archive(false, bound.item.id, entry.target)}>解除关联并归档编排</button></div> : <><label>对应歌曲<select aria-label={`Timecode ${entry.target} 对应歌曲`} disabled={disabled || busy || !entry.preview || Boolean(entry.error)} value={paired?.id ?? ''} onChange={event => { if (event.target.value) void pair(entry.target, event.target.value); }}><option value="">选择歌曲，Cue 放到它的时间线</option>{project.rundown.map(item => <option key={item.id} value={item.id}>{item.title} · {item.playback || item.p1Media ? `MTC ${mtcText(item, frameRate)}` : '没设 MTC，用这首歌的起点'}</option>)}</select></label>{paired ? <button disabled={disabled || busy || !entry.preview || Boolean(entry.error)} onClick={() => void pair(entry.target, paired.id)}>确认并放到时间线</button> : null}
          {paired && cache.pairings?.[entry.target]?.status === 'suggested' ? <p>按 MTC 起点自动匹配到「{paired.title}」，确认后 Cue 放到它的时间线。</p> : null}{unresolved ? <p>{unresolved.reason}</p> : null}</>}
        {bound && conflict === entry.target ? <p role="alert">本地编排和控台上的版本不一致。<button onClick={() => setConflict(null)}>保留本地</button><button disabled={disabled || busy} onClick={() => refresh(bound.item.id, entry.target, true)}>归档本地，采用控台版本</button></p> : null}
        {!bound ? cache.detachedBindings?.filter(value => value.binding.timecode === entry.target).map(value => <p key={value.detachedAt}>已归档 {project.rundown.find(item => item.id === value.itemId)?.title ?? value.itemId} 的本地编排和完整控台数据。<button disabled={disabled || busy} onClick={() => archive(true, value.itemId, entry.target)}>恢复归档关联</button></p>) : null}
        {origin !== undefined ? <p>歌曲原始起点 {(origin / 1000).toFixed(3)} 秒 · 本地播放起点 {(song?.playback?.startMs ?? 0) / 1000} 秒；Cue 按导入音频的时间定位。{song?.p1Media?.sourceTrim?.applied ? `音频文件已按 P1 的裁剪（${song.p1Media.sourceTrim.startMs / 1000}～${song.p1Media.sourceTrim.endMs / 1000} 秒）处理，时间码不会重复计算这段裁剪。` : ''}</p> : null}
        {entry.preview?.unconverted.length ? <p className="ma2-native-note">{entry.preview.unconverted.length} 个事件保持控台原样。已识别的 Cue 可以查看，也能在本地编辑；播放时使用控台原有的 Timecode。这条时间线不能写回控台，本地修改不会影响控台。</p> : null}
        {cache.failures.filter(value => value.target === entry.target).map(value => <p role="alert" key={value.target}>{value.message}</p>)}
        <div className="ma2-browser-events"><table><thead><tr><th>歌曲位置 / 秒</th><th>原始时间</th><th>执行器</th><th>序列 / Cue</th><th>动作</th><th>名称</th><th>编辑</th></tr></thead><tbody>{entry.events.map(event => {
          const absolute = entry.frameFormat === '30 FPS' && /^\d+(?:\.\d+)?$/.test(event.time) && /^\d+(?:\.\d+)?$/.test(entry.offset ?? '0') ? (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30 : undefined;
          const native = entry.preview?.unconverted.find(value => value.path === event.path);
          return <tr key={event.path}><td>{absolute !== undefined && origin !== undefined ? ((absolute - origin) / 1000).toFixed(3) : '待确认'}</td><td>{event.time}</td><td>{event.executor}</td><td>{event.cue ?? '—'}</td><td>{event.action}</td><td>{event.name ?? '—'}</td><td title={native?.reason}>{native ? '控台原样' : entry.preview ? '可编辑' : '只读'}</td></tr>;
        })}</tbody></table></div>
      </article> : <article><p>没有符合筛选条件的时间线。</p></article>}
    </div>
  </section>;
}
