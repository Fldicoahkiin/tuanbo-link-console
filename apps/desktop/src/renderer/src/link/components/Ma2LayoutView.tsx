import { Ma2LayoutCanvas } from './Ma2LayoutCanvas';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { currentShowGate, useShowGate } from '../stores/show-state-store';
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, RefreshCw, List, Grid2X2, Map, MoreHorizontal, CornerDownLeft, Pencil, Move, ZoomIn, ZoomOut } from 'lucide-react';
import type { Ma2LayoutSnapshot } from '@tb/schema';
import { readMa2LayoutPage, useMa2LayoutPage, ma2LayoutConnection, updateMa2LayoutPage, currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { CuePoolGrid } from './CuePoolGrid';
import { Ma2MaterialMenu } from './Ma2MaterialMenu';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import { Button, IconButton, Switch } from '../ui';
import '../ma2-layout.css';

export function Ma2LayoutView({ selected, onBack, onNavigate, onSettings, renderItem, children, typeControl, toolbarHost }: {
  toolbarHost: HTMLElement | null;
  typeControl?: ReactNode;
  selected: boolean;
  onBack: () => void;
  onNavigate: () => void;
  onSettings?: (() => void) | undefined;
  renderItem: (item: Ma2LayoutSnapshot['items'][number]) => ReactNode;
  children: ReactNode;
}): JSX.Element {
  const state = useMa2LayoutPage();
  // 第 3 题 (S3b): the page refreshes and its layout changes only wait while the program moves, prepares or stops; the
  // banner says so in showGate's words. Pressing a key on the page is never held up (`ma2.executorPage.press`).
  const refreshGate = useShowGate('ma2.executorPage.refresh');
  const mutateGate = useShowGate('ma2.executor.mutate');
  const mutateWaits = mutateGate.kind === 'wait';
  const [view, setView] = useState<'compact' | 'native'>('compact');
  const [zoom, setZoom] = useState(1); const [fitKey, setFitKey] = useState(0); const [editing, setEditing] = useState(false); const [live, setLive] = useState(false);
  const [pages, setPages] = useState<import('@tb/schema').Ma2LayoutDirectory>([]); const [listing, setListing] = useState(false);
  useEffect(() => { setPages([]); setLive(false); setEditing(false); }, [state.scope]);
  useEffect(() => {
    if (!live || editing || state.busy || state.error) return;
    const timer = setInterval(() => {
      if (currentShowGate('ma2.executorPage.refresh').kind === 'wait' || Object.values(useMa2SyncStore.getState().songs).some(song => song.checking || song.state === 'syncing')) return;
      void readMa2LayoutPage(state.page, true).catch((cause: unknown) => { setLive(false); setInputError(String(cause)); });
    }, 2500);
    return () => clearInterval(timer);
  }, [live, editing, state.busy, state.error, state.page, state.snapshot]);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [renaming, setRenaming] = useState(false); const [layoutName, setLayoutName] = useState('');
  const [draft, setDraft] = useState(String(state.page));
  const [inputError, setInputError] = useState('');
  useEffect(() => { setDraft(String(state.page)); }, [state.scope, state.page]);
  useEffect(() => { if (state.snapshot) setInputError(''); }, [state.snapshot]);
  const navigate = (page: number): void => {
    if (!Number.isInteger(page) || page < 1 || page > 9999) { setInputError('请输入 1–9999 的页面编号'); return; }
    setInputError(''); setPagesOpen(false); setDraft(String(page)); onNavigate();
    void readMa2LayoutPage(page).catch((cause: unknown) => setInputError(cause instanceof Error ? cause.message : String(cause)));
  };
  const items = state.snapshot?.items.map(item => ({ item, content: renderItem(item) })).filter(value => value.content !== null) ?? [];
  return <section className="ma2-layout-view" aria-label="控台页面">
    {toolbarHost ? createPortal(<div className="ma2-layout-titlebar">
      {typeControl}
      <form className="ma2-layout-pager" onSubmit={event => { event.preventDefault(); navigate(Number(draft)); }}>
        <button type="button" aria-label="上一个控台页面" disabled={state.busy || state.page <= 1} onClick={() => navigate(state.page - 1)}><ChevronLeft/></button>
        <label>页面<input aria-label="控台页面编号" title={`Layout ${state.page}${state.snapshot?.name ? ` · ${state.snapshot.name}` : ''}，输入页码后回车跳转`} type="number" min="1" max="9999" step="1" value={draft} disabled={state.busy} onChange={event => setDraft(event.target.value)}/></label>
        <button type="submit" aria-label="跳转" title="跳转到此页" disabled={state.busy}><CornerDownLeft/></button>
        <button type="button" aria-label="下一个控台页面" disabled={state.busy || state.page >= 9999} onClick={() => navigate(state.page + 1)}><ChevronRight/></button>
      </form>
      <button aria-label="所有页面" title="选择控台页面" aria-expanded={pagesOpen} disabled={listing || state.busy} onClick={() => {
        if (pagesOpen) { setPagesOpen(false); return; }
        const scope = currentMa2LayoutScope(); setListing(true);
        void ma2LayoutConnection().then(connection => window.tbLink.listMa2Layouts(connection)).then(result => { if (scope === currentMa2LayoutScope()) { setPages(result); setPagesOpen(true); } }).catch((cause: unknown) => setInputError(String(cause))).finally(() => setListing(false));
      }}><List/></button>
      <button aria-label={view === 'native' ? '紧凑列表' : '控台原位置'} title={view === 'native' ? '切换紧凑列表' : '按控台原位置显示'} aria-pressed={view === 'native'} onClick={() => { setView(view === 'native' ? 'compact' : 'native'); setEditing(false); }}>{view === 'native' ? <Grid2X2/> : <Map/>}</button>
      <Ma2MaterialMenu label="页面选项" trigger={<MoreHorizontal/>} open={optionsOpen} onOpenChange={setOptionsOpen}>
        <p className="ma2-material-menu-label">Layout {state.page}{state.snapshot?.name ? ` · ${state.snapshot.name}` : ''}</p>
        <Button variant="ghost" size="sm" icon={RefreshCw} disabled={state.busy || refreshGate.kind === 'wait'} onClick={() => { setOptionsOpen(false); navigate(state.page); }}>刷新控台页面</Button>
        <Button variant="ghost" size="sm" icon={Pencil} disabled={state.busy || mutateWaits || !state.snapshot?.revision} onClick={() => { setLayoutName(state.snapshot?.name ?? ''); setRenaming(!renaming); }}>重命名页面</Button>
        {view === 'native' ? <><Button variant="ghost" size="sm" icon={Move} aria-pressed={editing} disabled={state.busy || mutateWaits || !state.snapshot?.revision} onClick={() => setEditing(!editing)}>编辑位置</Button><div className="ma2-layout-zoom" role="group" aria-label="缩放"><IconButton size="sm" variant="secondary" label="缩小控台页面" icon={ZoomOut} disabled={zoom <= .25} onClick={() => setZoom(Math.max(.25, zoom / 1.5))}/><Button variant="secondary" size="sm" onClick={() => { setZoom(1); setFitKey(value => value + 1); }}>适应</Button><IconButton size="sm" variant="secondary" label="放大控台页面" icon={ZoomIn} disabled={zoom >= 8} onClick={() => setZoom(Math.min(8, zoom * 1.5))}/></div></> : null}
        <Switch className="ma2-page-live-option" label="实时同步" aria-label="实时同步控台页面" checked={live} onChange={event => setLive(event.currentTarget.checked)}/>
      </Ma2MaterialMenu>
      {selected ? <button aria-label="返回页面" title="返回页面" onClick={onBack}><ArrowLeft/></button> : null}
      {onSettings ? <button aria-label="新建 Cue" title="新建 Cue 与本曲同步" disabled={state.busy} onClick={onSettings}><Plus/></button> : null}
    </div>, toolbarHost) : null}
    {pagesOpen ? <div className="ma2-layout-page-picker" role="dialog" aria-label="选择控台页面"><header><strong>控台页面</strong><button onClick={() => setPagesOpen(false)}>关闭</button></header>{pages.length ? <select aria-label="控台所有页面" size={Math.min(8, pages.length)} value={pages.some(page => page.layout === state.page) ? state.page : ''} onChange={event => navigate(Number(event.target.value))}>{pages.map(page => <option key={page.layout} value={page.layout}>{page.layout} · {page.name}</option>)}</select> : <p>控台没有已建立的 Layout</p>}</div> : null}
    {renaming ? <form className="ma2-layout-rename" onSubmit={event => { event.preventDefault(); void updateMa2LayoutPage({ positions: [], name: layoutName }).then(() => setRenaming(false)).catch((cause: unknown) => setInputError(String(cause))); }}><input aria-label="控台页面名称" required maxLength={512} value={layoutName} onChange={event => setLayoutName(event.target.value)}/><Ma2ConsoleName name={layoutName}/><button disabled={state.busy || mutateWaits}>保存名称到控台</button><button type="button" onClick={() => setRenaming(false)}>取消</button></form> : null}
    {refreshGate.kind === 'wait' ? <p className="ma2-layout-note" role="status">{refreshGate.message}</p> : null}
    {state.busy && !state.snapshot ? <div className="ma2-layout-empty" role="status">正在读取第 {state.page} 页…</div> : inputError || state.error ? <div className="ma2-layout-empty" role="alert">{inputError || state.error}</div> : selected ? children : state.snapshot ? <>
      {items.length ? view === 'native' ? <Ma2LayoutCanvas key={`${state.scope}:${state.page}:${fitKey}`} snapshot={state.snapshot} items={items} zoom={zoom} editing={editing && !state.busy && !mutateWaits} onMove={(id, x, y) => { void updateMa2LayoutPage({ positions: [{ id, x, y }] }).catch((cause: unknown) => setInputError(String(cause))); }}/> : <CuePoolGrid key={`${state.scope}:${state.page}`} keys={items.map(({ item }) => item.id)} label={`Layout ${state.page} 素材`} cellWidth={156} rowHeight={50} render={index => items[index]!.content}/> : <div className="ma2-layout-empty">{state.snapshot.items.length ? '本页没有符合筛选条件的 Cue' : '此页面没有 Cue 按钮'}</div>}
      {state.snapshot.omittedFixtures > 0 ? <p className="ma2-layout-note">本页另有 {state.snapshot.omittedFixtures} 个灯具符号，这里只显示池对象。</p> : null}
    </> : <div className="ma2-layout-empty">输入页面编号，读取控台 Layout。</div>}
  </section>;
}
