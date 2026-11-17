import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, RefreshCw } from 'lucide-react';
import { formatMtcStart, parseMtcStart, songLightingStatus } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useSelectedProgram } from '../useSelectedProgram';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { selectMa2Timeline, changeMa2TimelineProperties } from '../runtime/ma2-timeline-actions';
import { ma2TimelineRows, type Ma2TimelineRow } from '../view-models/ma2-timeline-list';
import { ownKeys } from '../keys/key-owner';
import { Button, Dialog, Field, Menu, MenuItem, TextInput } from '../ui';
import { Ma2SequenceTimeline } from './Ma2SequenceTimeline';
import { scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import '../ma2-cached-browser.css';

type TimelineBrowserProps = { disabled: boolean; onClose: () => void; notify: (message: string, tone?: 'info' | 'error') => void; query?: string; embedded?: boolean; onClearSearch?: () => void };
export function Ma2CachedBrowser(props: TimelineBrowserProps): JSX.Element {
  const [itemId] = useSelectedProgram(props.notify);
  const { onClearSearch } = props;
  useEffect(() => { onClearSearch?.(); }, [itemId, onClearSearch]);
  return <Ma2TimelineWorkspace key={itemId} {...props} itemId={itemId} />;
}

function Ma2TimelineWorkspace({ itemId, disabled, onClose, notify, query = '', embedded = false, onClearSearch }: TimelineBrowserProps & { itemId: string | null }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const [showAll, setShowAll] = useState(false);
  const sync = useMa2SyncStore(state => itemId ? state.songs[itemId] : undefined);
  const session = useMa2SyncStore(state => state.session);
  const enabled = useMa2RealtimePreference(state => state.enabled);
  const read = useMa2ReadStore();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<{ target: number; owner: string | null } | null>(null);
  const [editing, setEditing] = useState<Ma2TimelineRow | null>(null);
  const [menu, setMenu] = useState<{ row: Ma2TimelineRow; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  if (!project) return <p>请先打开工程。</p>;
  const item = project.rundown.find(value => value.id === itemId);
  const status = item ? songLightingStatus(project, item.id) : null;
  const target = item?.lighting?.consoleSong?.timecode?.number ?? item?.lighting?.timelineDestination?.timecode ?? item?.lighting?.ma2Bindings?.[0]?.timecode ?? (status?.state === 'matched' ? status.timecode : undefined);
  const rows = ma2TimelineRows(project);
  const browsing = showAll || query.trim().length > 0;
  const visible = rows.filter(row => browsing ? `${row.target} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase()) : row.target === target);
  const selection = browsing ? selected : null;
  const row = (selection ? rows.find(value => value.target === selection.target && value.owner === selection.owner) : undefined) ?? (selection?.owner ? rows.find(value => value.owner === selection.owner) : undefined) ?? rows.find(value => value.target === (selection?.target ?? target)) ?? null;
  const code = (value: Ma2TimelineRow): string => value.startMs === null ? '起始码未读取' : formatMtcStart(value.startMs, project.timebase.frameRate);
  const current = row?.target === target;
  const attached = Boolean(item?.lighting?.consoleSong || item?.lighting?.timelineDestination || item?.lighting?.ma2Bindings?.some(binding => binding.timecode === target));
  const usedElsewhere = Boolean(row?.owner && row.owner !== itemId);
  const syncText = !current ? '未关联当前节目' : row?.error || !row?.loaded || !attached ? '尚未完成读取' : sync?.state === 'blocked' || session.status === 'blocked' ? '同步失败' : sync?.state === 'syncing' ? '同步中' : row?.pending ? '等待控台创建' : status?.state !== 'matched' ? '待匹配' : !enabled || sync?.state === 'paused' ? '同步暂停' : status?.state === 'matched' && (status.pending || status.problems.length || sync?.state === 'pending') ? '待同步' : '已同步';
  const run = async (action: () => Promise<string>): Promise<void> => { setBusy(true); setError(''); setMessage(''); try { const text = await action(); setMessage(text); notify(text); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } };
  const use = (value: Ma2TimelineRow, edit = false): void => {
    setMenu(null); setSelected({ target: value.target, owner: value.owner });
    if (edit && value.target === target && attached) { onClose(); return; }
    void run(async () => { if (!itemId) throw new Error('请先选择节目'); const text = await selectMa2Timeline(itemId, value.target); showCurrent(); if (edit) onClose(); return text; });
  };
  const showCurrent = (): void => { setShowAll(false); setSelected(null); onClearSearch?.(); };
  const selectRow = (value: Ma2TimelineRow): void => { setSelected({ target: value.target, owner: value.owner }); setError(''); setMessage(''); };
  const refresh = (): void => { void run(async () => { await scanMa2(await ma2MaterialConnection()); return '控台时间线已刷新'; }); };
  return <section className="ma2-timeline-pool" aria-label="控台时间线与歌曲">
    <div className="ma2-timeline-pool-actions"><span>当前节目：{item?.title ?? '未选择'}</span>{browsing ? <Button size="sm" onClick={showCurrent}>返回当前节目</Button> : target ? <Button size="sm" onClick={() => setShowAll(true)}>全部时间线（{rows.length}）</Button> : null}{target || browsing ? <Button size="sm" icon={Plus} disabled={disabled || busy || !item?.referenceAudio} onClick={() => setCreating(true)}>新建时间线</Button> : null}{!embedded ? <Button size="sm" icon={RefreshCw} disabled={busy || read.busy} onClick={refresh}>刷新控台时间线</Button> : null}</div>
    <div className="ma2-timeline-pool-body">
      <div className="ma2-timeline-main">
        {browsing || target ? <>
          <div className="ma2-timeline-list-heading"><strong>{browsing ? `全部控台时间线 · ${visible.length} 条` : '当前节目时间线'}</strong>{browsing ? <small>选择一条查看或关联</small> : null}</div>
          <div className="ma2-timeline-list-scroll">
            <div className="ma2-timeline-columns" aria-hidden="true"><span>编号</span><span>名称</span><span>MTC 起始码</span><span>Cue</span><span>状态</span></div>
            <div className="ma2-timeline-list" role="listbox" {...ownKeys('ArrowUp', 'ArrowDown', 'Home', 'End')} aria-label={browsing ? '控台所有时间线' : '当前节目时间线'}>
              {visible.map((value, index) => <button role="option" className="ma2-timeline-row" key={value.target} aria-label={`Timecode ${value.target} · ${value.name}`} aria-selected={row?.target === value.target} tabIndex={row?.target === value.target || index === 0 && !visible.some(entry => entry.target === row?.target) ? 0 : -1} title={`${value.name} · ${code(value)}`} onClick={() => selectRow(value)} onKeyDown={event => {
                const next = event.key === 'ArrowDown' ? Math.min(index + 1, visible.length - 1) : event.key === 'ArrowUp' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : null;
                if (next === null) return; event.preventDefault(); selectRow(visible[next]!); (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
              }} onContextMenu={event => { event.preventDefault(); selectRow(value); setMenu({ row: value, x: event.clientX, y: event.clientY }); }}>
                <span>{value.target}</span><strong>{value.name || `Timecode ${value.target}`}</strong><span>{code(value)}</span><span>{value.loaded ? value.count : '—'}</span><small>{value.pending ? '待创建' : value.error ? '读取失败' : !value.loaded ? '尚未读取 Cue' : value.target === target ? '当前节目' : value.owner ? '已关联' : '未关联'}</small>
              </button>)}
            </div>
            {!visible.length ? <p className="ma2-timeline-empty-result">{rows.length ? '没有符合搜索条件的时间线' : '还没有控台时间线，可刷新或新建。'}</p> : null}
          </div>
        </> : <div className="ma2-timeline-empty"><strong>当前节目尚未关联时间线</strong><p>新建灯光编排，或选择控台上已有的时间线。</p><div><Button variant="primary" icon={Plus} disabled={disabled || busy || !item?.referenceAudio} onClick={() => setCreating(true)}>新建时间线</Button><Button disabled={busy} onClick={() => setShowAll(true)}>关联已有时间线</Button></div></div>}
      </div>
      <aside className="ma2-timeline-details" aria-label="所选时间线"><div className="ma2-timeline-details-heading">{row && current ? '当前时间线' : '时间线详情'}</div>
      {row ? <>
        <h3>{row.name || `Timecode ${row.target}`}</h3><p>Timecode {row.target} · MTC {code(row)}</p>
        <div className="ma2-timeline-status" role="status" aria-label="时间线状态"><span data-tone={current ? 'success' : 'waiting'}>{current ? row.pending ? '已关联 · 等待创建' : status?.state === 'matched' ? '已匹配当前节目' : '起始码未匹配' : usedElsewhere ? '已关联其他节目' : '未关联当前节目'}</span>{current ? <span data-tone={syncText === '已同步' ? 'success' : syncText === '同步失败' ? 'error' : 'waiting'}>{syncText}</span> : null}</div>
        {row.owner ? <p>{(() => { const lighting = project.rundown.find(song => song.id === row.owner)?.lighting; const sequence = lighting?.consoleSong?.sequence ?? lighting?.timelineDestination?.sequence; const executor = lighting?.consoleSong?.executor ?? lighting?.timelineDestination?.executor; return sequence ? `序列 ${sequence} · 执行器 ${executor ?? '未分配'}` : ''; })()}</p> : null}
        <p>{row.loaded ? `${row.count} 个 Cue` : 'Cue 尚未读取'}{row.count === 0 && row.loaded ? ' · 这是一条空时间线，可以进入编辑添加 Cue。' : ''}</p>
        {row.error ? <p role="alert">{row.error}</p> : null}
        {current ? <p role="status">{sync?.message || session.message}</p> : <p>用于当前节目时，会对齐节目 MTC 起始码并载入 Cue，原编排先存档。</p>}
        <div className="ma2-timeline-detail-actions"><Button variant="primary" disabled={disabled || busy || read.busy || usedElsewhere || !item?.referenceAudio} onClick={() => use(row)}>{current ? row.pending || item?.lighting?.consoleSong ? '同步当前时间线' : '重新读取 Cue' : '用于当前节目'}</Button><Button disabled={disabled || busy || usedElsewhere || !item?.referenceAudio} onClick={() => use(row, true)}>编辑 Cue</Button><Button disabled={disabled || busy || read.busy} onClick={() => setEditing(row)}>修改名称 / MTC</Button></div>
        <small>{project.ma2ReadState ? `控台列表读取于 ${new Date(project.ma2ReadState.catalog.readAt).toLocaleString()}` : '新建记录已保存在当前节目中'}</small>
      </> : <p>选中时间线后，在这里查看状态、修改名称和 MTC，或进入 Cue 编辑。</p>}
      {error ? <p role="alert">{error}</p> : message ? <p role="status">{message}</p> : null}
      {read.busy ? <p role="status">{read.progress?.detail ?? read.message}</p> : null}
      </aside>
    </div>
    {menu ? <Menu x={menu.x} y={menu.y} label="时间线右键菜单" title={`Timecode ${menu.row.target} · ${menu.row.name}`} onClose={() => setMenu(null)}><MenuItem icon={Check} disabled={busy || disabled || Boolean(menu.row.owner && menu.row.owner !== itemId) || !item?.referenceAudio} onSelect={() => use(menu.row)}>用于当前节目</MenuItem><MenuItem icon={Pencil} disabled={busy || disabled} onSelect={() => { setEditing(menu.row); setMenu(null); }}>修改名称 / MTC</MenuItem><MenuItem disabled={busy || disabled || Boolean(menu.row.owner && menu.row.owner !== itemId) || !item?.referenceAudio} onSelect={() => use(menu.row, true)}>编辑 Cue</MenuItem></Menu> : null}
    {creating && itemId ? <Dialog title="新建时间线" onClose={() => setCreating(false)}><Ma2SequenceTimeline itemId={itemId} disabled={disabled} notify={(text, tone) => { notify(text, tone); if (tone !== 'error') { const next = useDocumentStore.getState().project?.rundown.find(song => song.id === itemId)?.lighting?.timelineDestination?.timecode; setSelected(next ? { target: next, owner: itemId } : null); setCreating(false); showCurrent(); setMessage(text); } }} /></Dialog> : null}
    {editing ? <TimelineProperties row={editing} frameRate={project.timebase.frameRate} onClose={() => setEditing(null)} onSaved={text => { setEditing(null); setMessage(text); notify(text); }} /> : null}
  </section>;
}

function TimelineProperties({ row, frameRate, onClose, onSaved }: { row: Ma2TimelineRow; frameRate: import('@tb/schema').MtcFrameRate; onClose: () => void; onSaved: (message: string) => void }): JSX.Element {
  const [name, setName] = useState(row.name); const [start, setStart] = useState(row.startMs === null ? '' : formatMtcStart(row.startMs, frameRate));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <Dialog title="修改时间线" description={`Timecode ${row.target} · 修改名称和起始码，Cue 在歌曲内的相对位置保持不变。`} onClose={() => { if (!busy) onClose(); }}>
    <form className="ma2-timeline-properties" onSubmit={event => { event.preventDefault(); setBusy(true); setError(''); void (async () => { try { onSaved(await changeMa2TimelineProperties(row.target, name, start === (row.startMs === null ? '' : formatMtcStart(row.startMs, frameRate)) && row.startMs !== null ? row.startMs : parseMtcStart(start, frameRate))); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } })(); }}>
      <Field label="时间线名称" stacked>{props => <TextInput {...props} required disabled={busy} value={name} onChange={event => setName(event.target.value)} />}</Field><Field label="MTC 起始码" stacked>{props => <TextInput {...props} required disabled={busy} placeholder="00:00:00" value={start} onChange={event => setStart(event.target.value)} />}</Field>
      {error ? <p role="alert">{error}</p> : null}<Button type="submit" variant="primary" disabled={busy}>{busy ? '正在保存并确认…' : '保存修改'}</Button>
    </form>
  </Dialog>;
}
