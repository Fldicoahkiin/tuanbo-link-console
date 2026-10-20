import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, CornerDownLeft, RefreshCw, List, ArrowLeft, Plus, MoreHorizontal } from 'lucide-react';
import type { Ma2ExecutorPage } from '@tb/schema';
import { currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { useMa2ExecutorPageStore, prepareMa2ExecutorPages, loadMa2ExecutorDirectory, loadMa2ExecutorPage, scanMa2ExecutorLocations } from '../stores/ma2-executor-page-store';
import { useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';
import { Ma2FaderBank } from './Ma2FaderBank';
import { Ma2MaterialMenu } from './Ma2MaterialMenu';

export function Ma2ExecutorPageView({ typeControl, toolbarHost, faderToolbarHost, selected, onBack, onNavigate, onSettings, renderItem, children }: {
  toolbarHost: HTMLElement | null; faderToolbarHost: HTMLElement | null;
  typeControl: ReactNode; selected: boolean; onBack: () => void; onNavigate: () => void; onSettings?: (() => void) | undefined;
  renderItem: (item: Ma2ExecutorPage['items'][number], page: number) => ReactNode; children: ReactNode;
}): JSX.Element {
  const state = useMa2ExecutorPageStore();
  const scope = currentMa2LayoutScope();
  const [draft, setDraft] = useState(String(state.page)); const [picker, setPicker] = useState(false); const [live, setLive] = useState(true);
  const [inputError, setInputError] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [progressHost, setProgressHost] = useState<HTMLElement | null>(null);
  const snapshot = state.scope === scope ? state.pages[state.page] : undefined;
  useEffect(() => { setProgressHost(window.document.getElementById('ma2-sidebar-read-actions')); }, []);
  useEffect(() => { setDraft(String(state.page)); }, [state.page]);
  useEffect(() => {
    let active = true;
    prepareMa2ExecutorPages();
    void loadMa2ExecutorDirectory().then(directory => {
      if (!active) return;
      const current = useMa2ExecutorPageStore.getState();
      const kind = current.kind === 'fader' ? 'fader' : 'button';
      const page = current.navigation ? current.page : current.selectedPages[kind] ?? (kind === 'fader' ? directory.faderPage : directory.buttonPage);
      return loadMa2ExecutorPage(page);
    }).catch((cause: unknown) => { if (active) setInputError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [scope]);
  useEffect(() => {
    const current = useMa2ExecutorPageStore.getState();
    if (!current.navigation || current.scope !== scope || current.busy || current.pages[current.page]) return;
    void loadMa2ExecutorPage(current.page).catch((cause: unknown) => setInputError(String(cause)));
  }, [state.navigation, scope]);
  useEffect(() => {
    if (!live || selected || state.busy || state.scanning || state.error || inputError || !snapshot) return;
    const timer = setInterval(() => {
      const automatic = useMa2AutoSyncStore.getState();
      if (automatic.status === 'writing' || automatic.status === 'reading') return;
      void loadMa2ExecutorPage(state.page).catch((cause: unknown) => setInputError(String(cause)));
    }, 1000);
    return () => clearInterval(timer);
  }, [live, selected, state.busy, state.scanning, state.error, inputError, state.page, snapshot]);
  const navigate = (page: number): void => {
    setInputError(''); setPicker(false); onNavigate();
    void loadMa2ExecutorPage(page).catch((cause: unknown) => setInputError(cause instanceof Error ? cause.message : String(cause)));
  };
  const start = state.kind === 'fader' ? 1 : 101;
  const end = state.kind === 'fader' ? 90 : snapshot?.items.some(item => item.slot >= 201) ? 240 : 190;
  const slots = Array.from({ length: end - start + 1 }, (_, index) => start + index);
  const assigned = new Map(snapshot?.items.map(item => [item.slot, item]));
  const continuation = new Set(snapshot?.items.flatMap(item => Array.from({ length: item.width - 1 }, (_, i) => item.slot + i + 1)));
  return <section className="ma2-layout-view ma2-executor-view" aria-label="控台执行器页面">
    {toolbarHost ? createPortal(<div className="ma2-layout-titlebar">
      {typeControl}
      <form className="ma2-layout-pager" onSubmit={event => { event.preventDefault(); navigate(Number(draft)); }}>
        <button type="button" aria-label="上一个控台页面" disabled={state.busy || state.page <= 1} onClick={() => navigate(state.page - 1)}><ChevronLeft/></button>
        <label>页面<input aria-label="控台页面编号" title={`第 ${state.page} 页${snapshot?.name ? ` · ${snapshot.name}` : ''}，输入页码后回车跳转`} type="number" min={1} max={9999} value={draft} onChange={event => setDraft(event.target.value)}/></label>
        <button type="submit" aria-label="跳转" title="跳转到此页" disabled={state.busy}><CornerDownLeft/></button>
        <button type="button" aria-label="下一个控台页面" disabled={state.busy || state.page >= 9999} onClick={() => navigate(state.page + 1)}><ChevronRight/></button>
      </form>
      <button aria-label="所有页面" title="所有页面" aria-expanded={picker} onClick={() => { setPicker(!picker); if (!picker) void loadMa2ExecutorDirectory().catch((cause: unknown) => setInputError(String(cause))); }}><List/></button>
      <Ma2MaterialMenu label="页面选项" trigger={<MoreHorizontal/>} open={optionsOpen} onOpenChange={setOptionsOpen}>
        <p>{snapshot?.name || `${state.kind === 'fader' ? '推杆' : '按钮'}第 ${state.page} 页`}</p>
        <button disabled={state.busy} onClick={() => { setOptionsOpen(false); navigate(state.page); }}><RefreshCw/>刷新控台页面</button>
        <label className="ma2-page-live-option"><input aria-label="实时回读执行器页面" type="checkbox" checked={live} onChange={event => setLive(event.target.checked)}/>实时回读页面</label>
      </Ma2MaterialMenu>
      {selected ? <button aria-label="返回页面" title="返回页面" onClick={onBack}><ArrowLeft/></button> : null}
      {onSettings ? <button aria-label="新建 Cue" title="新建 Cue" onClick={onSettings}><Plus/></button> : null}
    </div>, toolbarHost) : null}
    {picker ? <div className="ma2-layout-page-picker" role="dialog" aria-label="选择控台页面"><header><strong>执行器页面</strong><button onClick={() => setPicker(false)}>关闭</button></header><select aria-label="控台所有页面" size={8} value={state.page} onChange={event => navigate(Number(event.target.value))}>{state.directory?.pages.map(page => <option key={page.page} value={page.page}>{page.page}{page.name ? ` · ${page.name}` : ''}</option>)}</select></div> : null}
    {inputError || state.error ? <div className="ma2-layout-empty" role="alert">{inputError || state.error}<button onClick={() => navigate(state.page)}>重新读取本页</button></div> : selected ? children : snapshot && state.kind === 'fader' ? <Ma2FaderBank page={snapshot} scope={scope} toolbarHost={faderToolbarHost} renderItem={renderItem}/> : snapshot ? <div className="ma2-executor-scroll"><div className="ma2-executor-grid" aria-label={`${state.kind === 'fader' ? '推杆' : '按钮'}第 ${state.page} 页`}>
      {slots.map(slot => {
        if (continuation.has(slot)) return null;
        const item = assigned.get(slot); const index = slot - start;
        return <div key={slot} className="ma2-executor-cell" data-executor-slot={slot} data-group-start={index % 5 === 0 && index % 15 !== 0} data-empty={!item} data-located={state.slot === slot} style={{ gridColumn: `${index % 15 + 1} / span ${item?.width ?? 1}`, gridRow: Math.floor(index / 15) + 1 }}>
          <span className="ma2-executor-number" title={`执行器 ${state.page}.${slot}`}>{slot}</span>{item ? renderItem(item, state.page) : <span className="ma2-executor-empty" aria-label={`${slot} 格为空`}/>}
        </div>;
      })}
    </div></div> : <div className="ma2-layout-empty" role="status">正在读取第 {state.page} 页…</div>}
    {progressHost ? createPortal(<div className="ma2-page-index-progress"><button disabled={state.scanning} onClick={() => { setInputError(''); void scanMa2ExecutorLocations().catch((cause: unknown) => setInputError(String(cause))); }}>{state.scanning ? `读取 Cue 位置 ${state.completed}/${state.total || '…'} 页` : '读取全部 Cue 位置'}</button>{state.scanning && state.total ? <progress aria-label="控台页面读取进度" max={state.total} value={state.completed}/> : null}{state.complete ? <small>全部 {state.completed} 页位置已读取</small> : null}</div>, progressHost) : null}
  </section>;
}
