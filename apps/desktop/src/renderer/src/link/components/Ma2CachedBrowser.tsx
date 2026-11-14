import { useState } from 'react';
import { refreshMa2BindingCommand, detachMa2BindingCommand, pairSongWithMa2ShowCommand, restoreMa2BindingCommand, formatMtcOffset, ma2ShowStartTicks, ma2SongPairs, programTimeOrigin, readSongMtcStart } from '@tb/core/link';
import type { LinkProject, Ma2ReadState } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { readMa2ShowNow } from '../runtime/ma2-console-version';
import { importCachedMa2, updateMa2ReadState } from '../stores/ma2-read-store';
import { useSelectedProgram } from '../useSelectedProgram';
import '../ma2-cached-browser.css';

type Entry = Ma2ReadState['catalog']['entries'][number];
type Song = LinkProject['rundown'][number];

/** One console Timecode show next to the song that starts where it starts (2026-10-26: by the MTC start alone). */
type Row = { entry: Entry; song: Song | undefined; bound: boolean; state: 'matched' | 'unmatched' | 'error'; text: string; reason: string | null };

function rowsOf(project: LinkProject, cache: Ma2ReadState): Row[] {
  const match = ma2SongPairs(project);
  const bindings = new Map(project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).map(binding => [binding.timecode, item] as const)));
  return cache.catalog.entries.map(entry => {
    const pairedId = match.pairs[entry.target];
    const song = project.rundown.find(item => item.id === pairedId) ?? bindings.get(entry.target);
    const bound = bindings.has(entry.target);
    const reason = match.unresolved.find(value => value.target === entry.target)?.reason ?? null;
    if (entry.error) return { entry, song, bound, state: 'error', text: '读取出错', reason: entry.error };
    if (pairedId && song) return { entry, song, bound, state: 'matched', text: `对上「${song.title}」${bound ? ' · Cue 已放进歌曲' : ''}`, reason: null };
    return { entry, song, bound, state: 'unmatched', text: reason ? '没对上' : entry.eventCount === 0 ? '空节目' : '没有歌曲从这个起点开始', reason };
  });
}

/** The show's start as an MTC code, or what the console wrote when it is not a start. */
function showStartText(entry: Entry, frameRate: LinkProject['timebase']['frameRate']): string {
  const ticks = ma2ShowStartTicks(entry);
  return ticks === null ? entry.offset ?? '没有起点' : formatMtcOffset(ticks * 1000 / 30, frameRate);
}

/**
 * Which song runs with this console show, picked by hand (2026-11-04). Pairing stays by the MTC start:
 * picking a song gives it the show's start, and the song changes over to this show.
 */
function ShowSongPicker({ project, row, disabled, notify, selectSong }: { project: LinkProject; row: Row; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; selectSong: (itemId: string) => void }): JSX.Element | null {
  const target = row.entry.target;
  const [choice, setChoice] = useState(row.song?.id ?? '');
  const frameRate = project.timebase.frameRate;
  const songs = project.rundown.filter(item => item.referenceAudio && !item.lighting?.consoleSong && !item.p1UnavailableSourceKey);
  if (row.state === 'error' || ma2ShowStartTicks(row.entry) === null || !songs.length) return null;
  const start = showStartText(row.entry, frameRate);
  const using = row.state === 'matched' && row.bound && row.song?.id === choice;
  const pair = (): void => {
    const item = songs.find(value => value.id === choice);
    if (!item) return;
    try {
      useDocumentStore.getState().execute(pairSongWithMa2ShowCommand(item.id, target));
      const after = useDocumentStore.getState().project;
      const placed = after?.rundown.find(value => value.id === item.id)?.lighting?.ma2Bindings?.some(binding => binding.timecode === target);
      if (placed) selectSong(item.id);
      const reason = after ? ma2SongPairs(after).unresolved.find(value => value.target === target)?.reason : undefined;
      notify(placed ? `「${item.title}」的起始码改成了 MTC ${start}，现在用 Timecode ${target} 跑灯` : `「${item.title}」的起始码改成了 MTC ${start}，但 Cue 没有换过来：${reason ?? '原因见这条时间线'}`, placed ? 'info' : 'error');
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return <div className="ma2-browser-pick">
    <label><span>给哪首歌用</span><select aria-label={`Timecode ${target} 给哪首歌用`} value={choice} onChange={event => setChoice(event.target.value)}>
      <option value="">选一首歌</option>
      {songs.map(item => { const reading = readSongMtcStart(item); return <option key={item.id} value={item.id}>{item.title} · {reading.state === 'set' ? `MTC ${formatMtcOffset(reading.startMs, frameRate)}` : '还没有起始码'}</option>; })}
    </select></label>
    <button disabled={disabled || !choice || using} title={using ? '这首歌已经在用这条时间线' : undefined} onClick={pair}>用这条时间线</button>
    {using ? null : <small>选好后，这首歌的 MTC 起始码改成 {start}，灯光换成这条时间线的 Cue。它原来用的时间线的 Cue 先归档，起始码改回去时恢复。</small>}
  </div>;
}

export function Ma2CachedBrowser({ disabled, onClose, notify }: { disabled: boolean; onClose: () => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const [, selectSong] = useSelectedProgram(notify);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const cache = project?.ma2ReadState;
  if (!project || !cache) return <section className="ma2-cached-browser"><header><h3>控台时间线</h3><button onClick={onClose}>返回编辑</button></header><p>还没读取过控台。在“设置 → MA2 控台”里连接一次，控台上的时间码节目会按 MTC 起始码自动对上歌曲。</p></section>;
  const frameRate = project.timebase.frameRate;
  const query = cache.query.toLowerCase();
  const rows = rowsOf(project, cache).filter(row => `${row.entry.target} ${row.entry.name} ${row.song?.title ?? ''}`.toLowerCase().includes(query) &&
    (cache.filter === 'all' || cache.filter === 'pending' && row.state === 'unmatched' && row.entry.eventCount !== 0 || cache.filter === 'native' && Boolean(row.entry.preview?.unconverted.length)
      || cache.filter === 'error' && (row.state === 'error' || Boolean(row.entry.conversionError) || cache.failures.some(value => value.target === row.entry.target))));
  const row = rows.find(value => value.entry.target === cache.selectedTarget) ?? rows[0];
  const entry = row?.entry;
  let origin: number | undefined;
  let originError = '';
  try { if (row?.song) origin = programTimeOrigin(row.song); }
  catch (error) { originError = error instanceof Error ? error.message : String(error); }
  const showStart = entry ? ma2ShowStartTicks(entry) : null;
  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await importCachedMa2();
      notify(result.failures.length ? `${result.imported.length} 首歌放进了 Cue，${result.failures.length} 条没放进去，原因在各条时间线里` : `${result.imported.length} 首歌放进了 Cue`, result.failures.length ? 'error' : 'info');
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  /**
   * 从控台刷新 (2026-11-11): connected, this one show is read from the console now; only while the console
   * is not connected does the last read stand in, and the message says when that read was made.
   */
  const refresh = async (itemId: string, target: number, archiveLocalEdits = false): Promise<void> => {
    setBusy(true);
    try {
      const song = useDocumentStore.getState().project?.rundown.find(item => item.id === itemId);
      const fresh = await readMa2ShowNow(target, song?.lighting?.ma2Bindings?.find(binding => binding.timecode === target)?.timeOriginMs);
      const cached = useDocumentStore.getState().project?.ma2ReadState;
      const readAt = cached?.catalog.entries.find(value => value.target === target)?.readAt ?? cached?.catalog.readAt;
      useDocumentStore.getState().execute(refreshMa2BindingCommand(itemId, target, archiveLocalEdits, fresh ?? undefined));
      setConflict(null);
      notify(fresh ? `已从控台重新读取 Timecode ${target}，放进了「${song?.title ?? ''}」` : `控台没连上，用的是 ${readAt ? new Date(readAt).toLocaleString() : '上次'} 读到的 Timecode ${target}`);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); if (message.includes('本地编排已有修改')) setConflict(target); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const archive = (restore: boolean, itemId: string, target: number): void => {
    try { useDocumentStore.getState().execute((restore ? restoreMa2BindingCommand : detachMa2BindingCommand)(itemId, target)); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return <section className="ma2-cached-browser" aria-label="控台时间线与歌曲">
    <header><div><h3>控台时间线</h3><small>上次读取 · {cache.source} · {cache.catalog.directory.show} · {new Date(cache.catalog.readAt).toLocaleString()} · 控台和歌曲的 MTC 起始码一样就自动对上，不用确认</small></div><button onClick={onClose}>返回编辑</button></header>
    <div className="ma2-browser-tools"><input aria-label="筛选控台时间线" value={cache.query} placeholder="搜索时间线或歌曲" onChange={event => updateMa2ReadState({ query: event.target.value })} />
      <select aria-label="时间线状态筛选" value={cache.filter} onChange={event => { const filter = event.target.value; if (filter === 'all' || filter === 'pending' || filter === 'native' || filter === 'error') updateMa2ReadState({ filter }); }}><option value="all">全部</option><option value="pending">没对上</option><option value="native">含控台原样动作</option><option value="error">读取出错</option></select>
      <button disabled={disabled || busy} title="把对上的控台节目的 Cue 放进歌曲的时间线；连接控台时会自动做" onClick={() => void apply()}>把 Cue 放进对上的歌曲</button><span role="status">{cache.message}</span></div>
    <div className="ma2-browser-body"><nav aria-label="已读取时间线">{rows.map(value => <button key={value.entry.target} data-state={value.state} aria-pressed={value.entry.target === entry?.target} onClick={() => { updateMa2ReadState({ selectedTarget: value.entry.target }); if (value.song) selectSong(value.song.id); }}>
      <strong>{value.entry.target} · {value.entry.name}</strong><span>{value.text} · MTC {showStartText(value.entry, frameRate)} · {value.entry.eventCount ?? '未知'} 个事件</span></button>)}</nav>
      {row && entry ? <article><h4>Timecode {entry.target} · {entry.name}</h4><p>{entry.frameFormat} · 节目起点 <strong className="ma2-browser-mtc">MTC {showStart === null ? entry.offset : formatMtcOffset(showStart * 1000 / 30, frameRate)}</strong> · {entry.slot}</p>
        <p className="ma2-browser-match" data-state={row.state}>{row.state === 'matched' && row.song ? `和「${row.song.title}」的 MTC 起始码一样，播放这首歌时控台跑这条时间线` : row.reason ?? row.text}</p>
        {row.song && origin !== undefined && row.state !== 'matched' ? <p>「{row.song.title}」的起始码是 <strong className="ma2-browser-mtc">MTC {formatMtcOffset(origin, frameRate)}</strong></p> : null}
        <ShowSongPicker key={`${entry.target}:${row.song?.id ?? ''}`} project={project} row={row} disabled={disabled || busy} notify={notify} selectSong={selectSong} />
        {entry.conversionError || originError ? <p role="alert">{entry.conversionError ?? originError}</p> : null}
        {row.bound && row.song ? <div className="ma2-browser-tools"><button onClick={() => { selectSong(row.song!.id); onClose(); }}>查看歌曲 Cue 与音频</button><button disabled={disabled || busy} title="控台连着时重新读这条时间线；没连上时用上次读到的" onClick={() => void refresh(row.song!.id, entry.target)}>从控台刷新</button><button disabled={disabled || busy} onClick={() => archive(false, row.song!.id, entry.target)}>解除关联并归档编排</button></div> : null}
        {row.bound && row.song && conflict === entry.target ? <p role="alert">本地编排和控台上的版本不一致。<button onClick={() => setConflict(null)}>保留本地</button><button disabled={disabled || busy} onClick={() => void refresh(row.song!.id, entry.target, true)}>归档本地，采用控台版本</button></p> : null}
        {!row.bound ? cache.detachedBindings?.filter(value => value.binding.timecode === entry.target).map(value => {
          const owner = project.rundown.find(item => item.id === value.itemId);
          const now = owner?.lighting?.ma2Bindings?.map(binding => `Timecode ${binding.timecode}`).join('、');
          return <p key={value.detachedAt}>已归档「{owner?.title ?? value.itemId}」在这条时间线上的 Cue 和本地改动{now ? `，这首歌现在用 ${now}` : ''}。<button disabled={disabled || busy || Boolean(now)} title={now ? '这首歌正在用别的时间线：把它的起始码改回这条的起点，会自动恢复' : undefined} onClick={() => archive(true, value.itemId, entry.target)}>恢复归档关联</button></p>;
        }) : null}
        {entry.preview?.unconverted.length ? <p className="ma2-native-note">{entry.preview.unconverted.length} 个控台动作联动台不转换，写回时保持控台原样（按键松开跟着按下一起移动）。其余 Cue 可以在联动台里改时间、增删，并写回这条时间线。</p> : null}
        {cache.failures.filter(value => value.target === entry.target).map(value => <p role="alert" key={value.target}>{value.message}</p>)}
        <div className="ma2-browser-events"><table><thead><tr><th>歌曲位置 / 秒</th><th>控台时间</th><th>执行器</th><th>序列 / Cue</th><th>动作</th><th>名称</th><th>编辑</th></tr></thead><tbody>{entry.events.map(event => {
          const absolute = showStart !== null && /^\d+(?:\.\d+)?$/.test(event.time) ? (Number(event.time) + showStart) * 1000 / 30 : undefined;
          const native = entry.preview?.unconverted.find(value => value.path === event.path);
          return <tr key={event.path}><td>{absolute !== undefined && origin !== undefined ? ((absolute - origin) / 1000).toFixed(3) : '—'}</td><td>{event.time}</td><td>{event.executor}</td><td>{event.cue ?? '—'}</td><td>{event.action}</td><td>{event.name ?? '—'}</td><td title={native?.reason}>{native ? '控台原样' : entry.preview ? '可编辑' : '只读'}</td></tr>;
        })}</tbody></table></div>
      </article> : <article><p>没有符合筛选条件的时间线。</p></article>}
    </div>
  </section>;
}
