import { useState } from 'react';
import { matchMa2Programs, parseP1TimeOrigin } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, updateMa2ReadState } from '../stores/ma2-read-store';
import { useSelectedProgram } from '../useSelectedProgram';
import '../ma2-cached-browser.css';

export function Ma2CachedBrowser({ disabled, onClose, notify }: { disabled: boolean; onClose: () => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const [, selectSong] = useSelectedProgram(notify);
  const [busy, setBusy] = useState(false);
  const cache = project?.ma2ReadState;
  if (!project || !cache) return <section className="ma2-cached-browser"><header><h3>控台时间线</h3><button onClick={onClose}>返回编辑</button></header><p>请在设置 → MA2 控台读取一次。目录、Cue 和配对会保存在当前工程。</p></section>;
  const bindings = new Map(project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).map(binding => [binding.timecode, { item, binding }] as const)));
  const status = (target: number): string => {
    const entry = cache.catalog.entries.find(value => value.target === target);
    if (!entry || entry.error) return '读取异常';
    if (entry.conversionError || cache.failures.some(value => value.target === target)) return '需处理';
    return `${bindings.has(target) ? '已配对' : '已读取'} · ${entry.preview?.unconverted.length ? '原生保留' : '可编辑'}`;
  };
  const rows = cache.catalog.entries.filter(entry => `${entry.target} ${entry.name} ${bindings.get(entry.target)?.item.title ?? ''}`.toLowerCase().includes(cache.query.toLowerCase()) &&
    (cache.filter === 'all' || cache.filter === 'pending' && !bindings.has(entry.target) || cache.filter === 'native' && Boolean(entry.preview?.unconverted.length) || cache.filter === 'error' && Boolean(entry.error || entry.conversionError || cache.failures.some(value => value.target === entry.target))));
  const entry = rows.find(value => value.target === cache.selectedTarget) ?? rows[0];
  const bound = entry ? bindings.get(entry.target) : undefined;
  const paired = entry ? project.rundown.find(item => item.id === cache.pairs[entry.target]) : undefined;
  const song = bound?.item ?? paired;
  let origin: number | undefined;
  let originError = '';
  try { if (song) origin = song.p1Media ? parseP1TimeOrigin(song.p1Media.midiStartTime) : song.playback?.mtcOffsetMs ?? 0; }
  catch (error) { originError = error instanceof Error ? error.message : String(error); }
  const apply = async (target?: number): Promise<void> => {
    setBusy(true);
    try { await importCachedMa2(target); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const unresolved = entry ? matchMa2Programs(project, cache.catalog).unresolved.find(value => value.target === entry.target) : undefined;
  return <section className="ma2-cached-browser" aria-label="控台时间线与歌曲配对">
    <header><div><h3>控台时间线</h3><small>工程缓存 · {cache.source} · {cache.catalog.directory.show} · {new Date(cache.catalog.readAt).toLocaleString()} · 非实时状态</small></div><button onClick={onClose}>返回编辑</button></header>
    <div className="ma2-browser-tools"><input aria-label="筛选控台时间线" value={cache.query} placeholder="搜索时间线或已配对歌曲" onChange={event => updateMa2ReadState({ query: event.target.value })} />
      <select aria-label="时间线状态筛选" value={cache.filter} onChange={event => { const filter = event.target.value; if (filter === 'all' || filter === 'pending' || filter === 'native' || filter === 'error') updateMa2ReadState({ filter }); }}><option value="all">全部</option><option value="pending">待配对</option><option value="native">原生保留</option><option value="error">需处理</option></select>
      <button disabled={disabled || busy} onClick={() => void apply()}>应用已确认配对</button><span role="status">{cache.message}</span></div>
    <div className="ma2-browser-body"><nav aria-label="已读取时间线">{rows.map(row => <button key={row.target} aria-pressed={row.target === entry?.target} onClick={() => { updateMa2ReadState({ selectedTarget: row.target }); const linked = bindings.get(row.target); if (linked) selectSong(linked.item.id); }}><strong>{row.target} · {row.name}</strong><span>{status(row.target)} · {row.eventCount ?? '未知'} 个事件</span><small>{bindings.get(row.target)?.item.title ?? '尚未关联歌曲'}</small></button>)}</nav>
      {entry ? <article><h4>Timecode {entry.target} · {entry.name}</h4><p>{status(entry.target)} · {entry.frameFormat} · 原始偏移 {entry.offset} · {entry.slot}</p>
        {entry.error || entry.conversionError || originError ? <p role="alert">{entry.error ?? entry.conversionError ?? originError}</p> : null}
        {bound ? <div className="ma2-browser-tools"><strong>{bound.item.title}</strong><button onClick={() => { selectSong(bound.item.id); onClose(); }}>查看歌曲 Cue 与音频</button></div> : <><label>对应歌曲<select aria-label={`Timecode ${entry.target} 对应歌曲`} disabled={disabled || busy} value={cache.pairs[entry.target] ?? ''} onChange={event => updateMa2ReadState({ pairs: { ...cache.pairs, [entry.target]: event.target.value } })}><option value="">按原始起点核对歌曲</option>{project.rundown.map(item => <option key={item.id} value={item.id}>{item.title} · 起点 {item.p1Media?.midiStartTime ?? (item.playback?.mtcOffsetMs ?? 0) / 1000} 秒</option>)}</select></label><button disabled={disabled || busy || !paired || !entry.preview || Boolean(entry.error)} onClick={() => void apply(entry.target)}>关联此歌曲</button>{unresolved ? <p>{unresolved.reason}</p> : null}</>}
        {origin !== undefined ? <p>歌曲原始起点 {(origin / 1000).toFixed(3)} 秒 · 本地播放起点 {(song?.playback?.startMs ?? 0) / 1000} 秒；Cue 使用导入音频坐标。{song?.p1Media?.sourceTrim?.applied ? `P1 源文件裁剪 ${song.p1Media.sourceTrim.startMs / 1000}～${song.p1Media.sourceTrim.endMs / 1000} 秒已应用到音频文件，不重复计入时间码。` : ''}</p> : null}
        {entry.preview?.unconverted.length ? <p className="ma2-native-note">{entry.preview.unconverted.length} 个事件原生保留。已知 Cue 可查看和本地编辑；播放使用控台原有 Timecode。此时间线禁止写回，本地修改不会改变控台。</p> : null}
        {cache.failures.filter(value => value.target === entry.target).map(value => <p role="alert" key={value.target}>{value.message}</p>)}
        <div className="ma2-browser-events"><table><thead><tr><th>歌曲位置 / 秒</th><th>原始时间</th><th>执行器</th><th>序列 / Cue</th><th>动作</th><th>名称</th><th>能力</th></tr></thead><tbody>{entry.events.map(event => {
          const absolute = entry.frameFormat === '30 FPS' && /^\d+(?:\.\d+)?$/.test(event.time) && /^\d+(?:\.\d+)?$/.test(entry.offset ?? '0') ? (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30 : undefined;
          const native = entry.preview?.unconverted.find(value => value.path === event.path);
          return <tr key={event.path}><td>{absolute !== undefined && origin !== undefined ? ((absolute - origin) / 1000).toFixed(3) : '待核对'}</td><td>{event.time}</td><td>{event.executor}</td><td>{event.cue ?? '—'}</td><td>{event.action}</td><td>{event.name ?? '—'}</td><td title={native?.reason}>{native ? '原生保留' : entry.preview ? '可编辑' : '只读'}</td></tr>;
        })}</tbody></table></div>
      </article> : <article><p>没有符合筛选条件的时间线。</p></article>}
    </div>
  </section>;
}
