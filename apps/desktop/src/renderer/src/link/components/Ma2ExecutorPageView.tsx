import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, RefreshCw, List, ArrowLeft, Plus, MoreHorizontal, Pencil, Move, Trash2 } from 'lucide-react';
import { ma2ExecutorPageItemSchema, type Ma2ExecutorPage, type Ma2ExecutorUpdateRequest } from '@tb/schema';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { useMa2ExecutorPageStore, prepareMa2ExecutorPages, loadMa2ExecutorDirectory, loadMa2ExecutorPage, scanMa2ExecutorLocations, selectMa2ExecutorBandPage, updateMa2ExecutorPageItem, type Ma2ExecutorBand } from '../stores/ma2-executor-page-store';
import { useMa2ExecutorPages } from '../runtime/use-ma2-executor-pages';
import { Ma2MaterialMenu } from './Ma2MaterialMenu';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import { Button, Dialog, Field, Menu, MenuItem, MenuSeparator, Switch, TextInput } from '../ui';
import { useKeyOverlay } from '../keys/useKeyCommands';
import { useMa2ExecutorChannel } from '../runtime/use-ma2-executor-channel';
import { Ma2KeyChannelMenu } from './Ma2KeyChannelMenu';
import '../ma2-executor.css';

const bands = [
  { id: 'upper', title: 'Button', input: '上层按钮页码', start: 101, end: 190 },
  { id: 'fader', title: 'Fader', input: '中层执行器页码', start: 1, end: 15 },
  { id: 'lower', title: 'Button', input: '下层按钮页码', start: 101, end: 115 }
] as const;
type PageItem = Ma2ExecutorPage['items'][number];
type Selection = { item: PageItem; page: number; x: number; y: number };
const executorDrag = 'application/x-tblink-ma2-executor';

export function Ma2ExecutorPageView({ typeControl, toolbarHost, selected, onBack, onNavigate, onSettings, renderItem, onEditItem, children }: {
  toolbarHost: HTMLElement | null; typeControl: ReactNode; selected: boolean; onBack: () => void; onNavigate: () => void; onSettings?: (() => void) | undefined;
  renderItem: (item: PageItem, page: number, band: Ma2ExecutorBand) => ReactNode;
  onEditItem: (item: PageItem, page: number) => void; children: ReactNode;
}): JSX.Element {
  const state = useMa2ExecutorPageStore();
  const scope = currentMa2LayoutScope();
  const [picker, setPicker] = useState<Ma2ExecutorBand | null>(null);
  // The page list is a panel like the others: Escape closes it, and the lighting shortcut keys wait while it is open.
  const pickerPanel = useRef<HTMLDivElement>(null);
  useKeyOverlay(picker !== null, { close: () => setPicker(null), panel: pickerPanel });
  const [live, setLive] = useState(true);
  const [notice, setNotice] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [menu, setMenu] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<{ selection: Selection; kind: 'rename' | 'move' | 'delete' } | null>(null);
  const [name, setName] = useState('');
  const [targetPage, setTargetPage] = useState('');
  const [targetSlot, setTargetSlot] = useState('');
  const formId = useId();
  const [dropTarget, setDropTarget] = useState('');
  const [ranges, setRanges] = useState({ upper: 101, fader: 1 });
  const directoryNextRead = useRef(0);
  const pageKey = JSON.stringify(state.bandPages);
  const report = (cause: unknown): void => setNotice(cause instanceof Error ? cause.message : String(cause));
  useEffect(() => {
    if (!state.slot) return;
    setRanges(current => state.activeBand === 'fader'
      ? { ...current, fader: Math.floor((state.slot! - 1) / 15) * 15 + 1 }
      : state.activeBand === 'upper' ? { ...current, upper: state.slot! > 190 ? 191 : 101 } : current);
  }, [state.navigation, state.slot, state.activeBand]);
  useEffect(() => {
    prepareMa2ExecutorPages(); setMenu(null); setEditing(null); setNotice('');
    directoryNextRead.current = 0;
  }, [scope]);
  useMa2ExecutorPages(scope, pageKey, live, selected, setNotice, directoryNextRead);
  const keyChannel = useMa2ExecutorChannel(scope, !selected);
  const navigate = (band: Ma2ExecutorBand, page: number): void => {
    try { selectMa2ExecutorBandPage(band, page); setNotice(''); setPicker(null); onNavigate(); }
    catch (cause) { report(cause); }
  };
  const refresh = (): void => {
    setNotice(''); directoryNextRead.current = Date.now() + 10000; void loadMa2ExecutorDirectory().then(async () => {
      for (const page of new Set(Object.values(useMa2ExecutorPageStore.getState().bandPages))) if (page !== null) await loadMa2ExecutorPage(page, true);
    }).catch(report);
  };
  const change = async (selection: Selection, action: Ma2ExecutorUpdateRequest['action']): Promise<void> => {
    setNotice('');
    try {
      await updateMa2ExecutorPageItem(selection.page, selection.item, action);
      setEditing(null); setMenu(null);
      setNotice(action.kind === 'move' ? `已移动：${selection.page}.${selection.item.slot} → ${action.page}.${action.slot}（已在控台确认）` : action.kind === 'delete' ? `已清空 ${selection.page}.${selection.item.slot} 的执行器，序列仍保留` : '名称已写入控台');
    } catch (cause) { report(cause); }
  };
  const edit = (kind: 'rename' | 'move' | 'delete'): void => {
    if (!menu) return;
    setName(menu.item.name); setTargetPage(String(menu.page)); setTargetSlot(String(menu.item.slot));
    setEditing({ selection: menu, kind }); setMenu(null); setNotice('');
  };
  return <section className="ma2-layout-view ma2-executor-view" aria-label="控台执行器页面">
    {toolbarHost ? createPortal(<div className="ma2-layout-titlebar">
      {typeControl}
      <Ma2MaterialMenu label="页面选项" trigger={<MoreHorizontal/>} open={optionsOpen} onOpenChange={setOptionsOpen}>
        <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => { setOptionsOpen(false); refresh(); }}>刷新控台页面</Button>
        {/* The scan's progress shows in the sidebar's task list while it runs. */}
        <Button variant="ghost" size="sm" icon={List} disabled={state.scanning} onClick={() => { setOptionsOpen(false); setNotice(''); void scanMa2ExecutorLocations().catch(report); }}>{state.scanning ? `正在读取 Cue 位置 ${state.completed}/${state.total || '…'} 页` : '读取全部 Cue 位置'}</Button>
        {state.complete ? <p className="ma2-page-index-done">全部 {state.completed} 页的位置已读取</p> : null}
        <Switch className="ma2-page-live-option" label="实时同步页面" aria-label="实时同步执行器页面" checked={live} onChange={event => setLive(event.currentTarget.checked)}/>
      </Ma2MaterialMenu>
      {selected ? <button aria-label="返回页面" title="返回页面" onClick={onBack}><ArrowLeft/></button> : null}
      {onSettings ? <button aria-label="新建 Cue" title="新建 Cue" onClick={onSettings}><Plus/></button> : null}
    </div>, toolbarHost) : null}
    {selected ? children : <div className="ma2-executor-surface">
      {bands.map(band => {
        const start = band.id === 'lower' ? band.start : ranges[band.id];
        const end = band.id === 'fader' ? Math.min(100, start + 14) : band.id === 'upper' ? start === 101 ? 190 : 240 : band.end;
        const page = state.bandPages[band.id];
        const snapshot = page && state.scope === scope ? state.pages[page] : undefined;
        const assigned = new Map(snapshot?.items.map(item => [item.slot, item]));
        const continuation = new Set(snapshot?.items.flatMap(item => Array.from({ length: item.width - 1 }, (_, i) => item.slot + i + 1)));
        const error = page ? state.pageErrors[page] : '';
        return <section key={band.id} data-executor-band={band.id} className="ma2-executor-band" aria-label={`${band.title} ${page ?? ''}`}>
          <header className="ma2-executor-band-header">
            <span>{band.title}</span>
            <ExecutorPageInput label={band.input} page={page ?? 1} onNavigate={value => navigate(band.id, value)}/>
            {band.id === 'fader' || band.id === 'upper' && (start > 190 || snapshot?.items.some(item => item.slot > 190)) ? <select className="ma2-executor-band-range" aria-label={band.id === 'fader' ? '中层执行器范围' : '上层按钮范围'} value={start} onChange={event => setRanges(current => ({ ...current, [band.id]: Number(event.target.value) }))}>
              {(band.id === 'fader' ? [1, 16, 31, 46, 61, 76, 91] : [101, 191]).map(value => <option key={value} value={value}>{value}–{band.id === 'fader' ? Math.min(100, value + 14) : value === 101 ? 190 : 240}</option>)}
            </select> : <span className="ma2-executor-band-caption">({start}…{end})</span>}
            <span className="ma2-executor-band-name" title={snapshot?.name}>{snapshot?.name}</span>
            {band.id !== 'fader' && keyChannel.state ? <Ma2KeyChannelMenu state={keyChannel.state} start={start} onChoose={keyChannel.choose} onError={setNotice}/> : null}
            <button aria-label={`${band.input}目录`} title="选择页面" onClick={() => setPicker(picker === band.id ? null : band.id)}><List/></button>
            {error ? <button className="ma2-executor-read-state" title={error} onClick={refresh}>等待控台确认</button> : !snapshot ? <small role="status">读取中…</small> : null}
          </header>
          <div className="ma2-executor-grid" aria-label={`${band.input} ${page ?? ''}`} data-stale={Boolean(error)}>
            {Array.from({ length: end - start + 1 }, (_, index) => start + index).map(slot => {
              if (continuation.has(slot)) return null;
              const item = assigned.get(slot); const index = slot - start;
              const address = `${page}.${slot}`;
              return <div key={slot} className="ma2-executor-cell" data-executor-slot={slot} data-executor-address={address} data-group-start={index % 5 === 0 && index % 15 !== 0}
                data-empty={!item} data-located={state.activeBand === band.id && state.slot === slot} data-drop-target={dropTarget === `${band.id}:${address}`}
                style={{ gridColumn: `${index % 15 + 1} / span ${Math.min(item?.width ?? 1, 15 - index % 15)}`, gridRow: Math.floor(index / 15) + 1, ...(item?.color ? { '--executor-color': item.color } : {}) } as CSSProperties}
                draggable={Boolean(item) && !state.mutating}
                onDragStart={event => {
                  if (!item || page === null) return;
                  event.dataTransfer.setData(executorDrag, JSON.stringify({ scope, page, item }));
                  event.dataTransfer.effectAllowed = 'copyMove';
                }}
                onDragOver={event => {
                  if (!event.dataTransfer.types.includes(executorDrag) || item || state.mutating) return;
                  event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(`${band.id}:${address}`);
                }}
                onDragLeave={() => setDropTarget('')} onDragEnd={() => setDropTarget('')}
                onDrop={event => {
                  setDropTarget(''); if (item || page === null || !event.dataTransfer.types.includes(executorDrag)) return;
                  event.preventDefault();
                  try {
                    const raw: unknown = JSON.parse(event.dataTransfer.getData(executorDrag));
                    if (!raw || typeof raw !== 'object' || !('scope' in raw) || raw.scope !== scope || !('page' in raw) || typeof raw.page !== 'number' || !('item' in raw)) throw new Error('拖动来源已变化，请重新拖动');
                    const origin = ma2ExecutorPageItemSchema.parse(raw.item);
                    void change({ item: origin, page: raw.page, x: 0, y: 0 }, { kind: 'move', page, slot });
                  } catch (cause) { report(cause); }
                }}
                onContextMenuCapture={event => {
                  if (!item || page === null) return;
                  event.preventDefault(); event.stopPropagation();
                  setMenu({ item, page, x: event.clientX, y: event.clientY });
                }}>
                <span className="ma2-executor-number" title={`执行器 ${address}`}>{slot}{item?.sequence ? <span> L{item.sequence}</span> : null}</span>
                {item && page !== null ? renderItem(item, page, band.id) : <span className="ma2-executor-empty" aria-label={`${slot} 格为空`}/>}
              </div>;
            })}
          </div>
        </section>;
      })}
    </div>}
    {picker ? <div ref={pickerPanel} className="ma2-layout-page-picker" role="dialog" aria-label="选择控台页面"><header><strong>{bands.find(band => band.id === picker)?.input}</strong><button onClick={() => setPicker(null)}>关闭</button></header><select aria-label="控台所有页面" size={8} value={state.bandPages[picker] ?? 1} onChange={event => navigate(picker, Number(event.target.value))}>{state.directory?.pages.map(page => <option key={page.page} value={page.page}>{page.page}{page.name ? ` · ${page.name}` : ''}</option>)}</select></div> : null}
    {menu ? <Menu x={menu.x} y={menu.y} label="执行器右键菜单" title={`${menu.item.name || '未命名'} · ${menu.page} 页 ${menu.item.slot} 格`} onClose={() => setMenu(null)}>
      <MenuItem icon={List} disabled={!menu.item.sequence} onSelect={() => { onEditItem(menu.item, menu.page); setMenu(null); }}>编辑步骤</MenuItem>
      <MenuItem icon={Pencil} disabled={state.mutating} onSelect={() => edit('rename')}>重命名</MenuItem>
      <MenuItem icon={Move} disabled={state.mutating} onSelect={() => edit('move')}>移动到…</MenuItem>
      <MenuSeparator/>
      <MenuItem icon={Trash2} danger disabled={state.mutating} onSelect={() => edit('delete')}>删除执行器</MenuItem>
    </Menu> : null}
    {editing ? <Dialog size="sm" title={editing.kind === 'rename' ? '重命名执行器' : editing.kind === 'move' ? '移动执行器' : '删除执行器'} description={`${editing.selection.page} 页 · ${editing.selection.item.slot} 格 · ${editing.selection.item.name || '未命名'}`} onClose={() => setEditing(null)}
      actions={<><Button variant="secondary" onClick={() => setEditing(null)}>取消</Button><Button type="submit" form={formId} variant={editing.kind === 'delete' ? 'danger' : 'primary'} loading={state.mutating} disabled={editing.kind === 'rename' && !name.trim()}>{state.mutating ? '正在确认…' : editing.kind === 'rename' ? '保存名称' : editing.kind === 'move' ? '确认移动' : '删除执行器'}</Button></>}>
      <form id={formId} className="ma2-executor-edit" onSubmit={event => {
        event.preventDefault();
        void change(editing.selection, editing.kind === 'rename' ? { kind: 'rename', name: name.trim() } : editing.kind === 'move' ? { kind: 'move', page: Number(targetPage), slot: Number(targetSlot) } : { kind: 'delete' });
      }}>
        {editing.kind === 'rename' ? <><Field stacked label="执行器名称">{field => <TextInput {...field} aria-label="执行器名称" autoFocus maxLength={512} value={name} onChange={event => setName(event.target.value)}/>}</Field><Ma2ConsoleName name={name}/></>
          : editing.kind === 'move' ? <div className="ma2-executor-destination"><Field stacked label="目标页码">{field => <TextInput {...field} aria-label="目标页码" type="number" min={1} max={9999} value={targetPage} onChange={event => setTargetPage(event.target.value)}/>}</Field><Field stacked label="目标格子">{field => <TextInput {...field} aria-label="目标格子" type="number" min={1} max={240} value={targetSlot} onChange={event => setTargetSlot(event.target.value)}/>}</Field></div>
          : <p>只清空这个格子的执行器，Sequence {editing.selection.item.sequence ?? ''} 和里面的 Cue 都保留。</p>}
        {notice ? <p className="ma2-executor-edit-error" role="alert">{notice}</p> : null}
      </form>
    </Dialog> : null}
    {state.mutating ? <p className="ma2-executor-status" role="status">已写入，正在向控台确认…</p> : notice && !editing ? <p className="ma2-executor-status" role="alert">{notice}</p> : null}
  </section>;
}

function ExecutorPageInput({ label, page, onNavigate }: { label: string; page: number; onNavigate: (page: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  return <form className="ma2-executor-band-pager" onSubmit={event => { event.preventDefault(); onNavigate(Number(draft)); }}>
    <button type="button" aria-label={`${label}上一页`} disabled={page <= 1} onClick={() => onNavigate(page - 1)}><ChevronLeft/></button>
    <input aria-label={label} title="输入页码，按回车切换" type="number" min={1} max={9999} value={draft} onChange={event => setDraft(event.target.value)}/>
    <button type="button" aria-label={`${label}下一页`} disabled={page >= 9999} onClick={() => onNavigate(page + 1)}><ChevronRight/></button>
  </form>;
}
