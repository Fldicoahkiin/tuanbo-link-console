import { Ma2CueAttributePicker, type CueAttributeEditor, type UseConsoleCue } from './Ma2CueAttributePicker';
import { useCueTrackingPreference } from '../runtime/ma2-realtime-preference';
import { Ma2CachedBrowser } from './Ma2CachedBrowser';
import { scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { LightingCategoryColors } from './LightingCategoryColors';
import { LightingAuditionStop } from './LightingAuditionStop';
import { useAuditionSelectionReset } from '../stores/ma2-audition-store';
import { useDocumentStore } from '../stores/document-store';
import { loadMa2MaterialCache } from './ma2-material-cache';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Plus, ListFilter, RefreshCw } from 'lucide-react';
import type { LightingDocument, Ma2PlaybackAction } from '@tb/schema';
import { LightingCueAudition } from '../../registry/lighting-cue-audition';
import '../ma2-sequence-preview.css';
import './lighting-page.css';

import { useConsoleCueClassification } from './useConsoleCueClassification';
import { consoleCueKey, type ConsoleCueReference } from '@tb/core/link';
import { Ma2EmptyCuePanel } from './Ma2EmptyCuePanel';
import { CuePoolGrid } from './CuePoolGrid';
import { Ma2CueCardLabel } from './Ma2CueCardLabel';
import { CONSOLE_CUE_DRAG, type ConsoleCueDrag } from './lighting-material-drag';
import { ma2ConsoleCueName, ma2ConsoleCuePoolName, ma2ConsoleSequenceName, ma2SequenceLibrary } from '../view-models/ma2-sequence-library';
import { useMa2AttributeStore } from '../stores/ma2-attribute-store';
import { ma2MaterialConnection, scanMa2Materials, useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { readMa2LayoutPage, useMa2LayoutPage } from '../stores/ma2-layout-store';
import { Ma2LayoutView } from './Ma2LayoutView';
import { Ma2ExecutorPageView } from './Ma2ExecutorPageView';
import { Ma2ExecutorKey } from './Ma2ExecutorKey';
import { useMa2ExecutorInput } from '../runtime/use-ma2-executor-input';
import { Ma2MaterialMenu } from './Ma2MaterialMenu';
import { Button } from '../ui';
import { Ma2CueLocations } from './Ma2CueLocations';
import { useMa2ExecutorPageStore, selectMa2ExecutorPageKind } from '../stores/ma2-executor-page-store';
export function Ma2SequencePreview({ document, itemId, currentPoint, currentIngredients, initialSequence, initialExecutor, onUse, composing = false, onBrowseLayout, onBrowseTimelines, notify, timelineOpen = false, onCloseTimelines, onLayoutSettings }: { itemId?: string; currentPoint?: string | undefined; currentIngredients?: import('./LightingCueComposer').CueIngredient[]; notify?: (message: string, tone?: 'info' | 'error') => void; composing?: boolean; initialSequence?: number; initialExecutor?: string; onBrowseLayout?: () => void; onBrowseTimelines?: () => void; timelineOpen?: boolean; onCloseTimelines?: () => void; onLayoutSettings?: () => void; onClassify?: (value: import('./LightingUserLibrary').LibraryDraft) => void; document: LightingDocument; onUse: UseConsoleCue; onClose: () => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const material = project ? loadMa2MaterialCache(project.projectId) : null;
  const [output] = useState(() => new LightingCueAudition());
  const [selected, setSelected] = useState<number | null>(initialSequence ?? null);
  const [query, setQuery] = useState('');
  const [timelineQuery, setTimelineQuery] = useState('');
  const clearTimelineSearch = useCallback(() => setTimelineQuery(''), []);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [category, setCategory] = useState<'all' | 'single' | 'multi' | 'layout'>('single');
  const layoutPage = useMa2LayoutPage();
  const pageKind = useMa2ExecutorPageStore(state => state.kind);
  const pageNavigation = useMa2ExecutorPageStore(state => state.navigation);
  const [singleSequence,setSingleSequence]=useState<number|null>(null);
  const [route, setRoute] = useState<string | null>(initialExecutor ?? null);
  const [selectedCue, setSelectedCue] = useState<string | null>(null);
  const lastAudition = useRef(0);
  const [error, setError] = useState('');
  const executorInput = useMa2ExecutorInput(setError);
  const classification=useConsoleCueClassification(setError);
  const attributesBusy = useMa2AttributeStore(state => state.busy);
  const timelinesReading = useMa2ReadStore(state => state.busy);
  const materialReading = useMa2MaterialReadStore(state => state.busy);
  const [refreshing, refreshMaterials] = useMaterialRefresh(timelineOpen, setError);
  const [pageToolbarHost, setPageToolbarHost] = useState<HTMLDivElement | null>(null);
  useAuditionSelectionReset(() => {
    lastAudition.current++;
    output.cancel();
    setSelectedCue(null);
    classification.setPicked([]);
  });
  useEffect(() => () => output.close(), [output]);
  const library = useMemo(() => ma2SequenceLibrary(project, document), [project, document]);
  const libraryById = useMemo(() => new Map(library.map(value => [value.sequence, value])), [library]);
  const index = useMemo(() => library.map(value => ({ value, text: `${value.sequence} ${value.name ?? ''} ${value.originalName ?? ''} ${value.cues.map(cue => `${cue.number} ${cue.name ?? ''} ${cue.originalName ?? ''}`).join(' ')}`.toLowerCase() })), [library]);
  const matchingSequences = useMemo(() => index.filter(({value,text}) => text.includes(query.toLowerCase()) && (category !== 'multi' || value.cues.length > 1)).map(entry=>entry.value),[index,query,category]);
  const visibleSequences=matchingSequences.filter(value=>classification.isVisible({sequence:value.sequence,cue:value.cues[0]?.number??'',kind:value.cues.length===1?'single':'sequence'}));
  const allSingles = useMemo(()=>library.flatMap(sequence=>sequence.cues.filter(cue=>`${sequence.sequence} ${sequence.name ?? ''} ${sequence.originalName ?? ''} ${cue.number} ${cue.name ?? ''} ${cue.originalName ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(cue=>({sequence,cue}))),[library,query]);
  const { isVisible } = classification;
  const singles = useMemo(() => allSingles.filter(({sequence,cue}) => isVisible({sequence:sequence.sequence,cue:cue.number,kind:'single'})), [allSingles,isVisible]);
  const singleRefs = useMemo(() => singles.map(({sequence,cue}):ConsoleCueReference => ({sequence:sequence.sequence,cue:cue.number,kind:'single'})), [singles]);
  const singleKeys = useMemo(() => singles.map(({sequence,cue}) => `${sequence.sequence}/${cue.number}`), [singles]);
  const sequence = libraryById.get(selected ?? singleSequence ?? -1);
  const activeStep = sequence?.cues.find(step => step.number === selectedCue);
  const tracking = useCueTrackingPreference(state => state.includeTracking);
  const directory = material?.library.directory;
  const editorRef = useRef<CueAttributeEditor>(null);
  const attributeKey = JSON.stringify([itemId, currentPoint, project?.projectId, material?.source, directory?.show, directory?.generation, sequence?.sequence, selectedCue, tracking]);
  const [choice, setChoice] = useState<{ key: string; attributes?: string[] | undefined; changed?: boolean }>({ key: attributeKey });
  if (choice.key !== attributeKey) setChoice({ key: attributeKey });
  const currentIngredient = currentIngredients?.find(entry => entry.sequence === sequence?.sequence && Number(entry.cue) === Number(selectedCue));
  const attributes = choice.key === attributeKey && choice.changed ? choice.attributes : currentIngredient?.attributes;
  const executors = sequence ? [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === sequence.sequence).map(mapping => mapping.executor)) ?? [])] : [];
  const executor = route ?? (executors.length === 1 ? executors[0]! : executors.length > 1 ? '__choose' : '');
  const send = async (action: Ma2PlaybackAction['action'], number?: string, chosen = sequence): Promise<void> => {
    if (!chosen) return;
    if (material?.library.sourceUnverified && action !== 'off') { setError('控台素材还没读取完整，请在“读取控台素材”里补读未完成项；已读到的步骤可以继续查看'); return; }
    const routes = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === chosen.sequence).map(mapping => mapping.executor)) ?? [])];
    const destination = chosen.sequence === sequence?.sequence ? executor : routes.length === 1 ? routes[0]! : '';
    if (destination === '__choose' || routes.length > 1 && (chosen.sequence !== sequence?.sequence || route === null)) { setError('这个序列有多个执行器，请先选择用哪一个播放'); return; }
    const turn = ++lastAudition.current;
    setError('');
    try {
      await output.playAction(destination ? { target: 'executor', executor: destination, action, ...(number ? { cue: number } : {}) } : { target: 'sequence', sequence: chosen.sequence, action, ...(number ? { cue: number } : {}) });
    } catch (cause) {
      if (turn === lastAudition.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const visibleCues = sequence?.cues.filter(value => classification.isVisible({sequence:sequence.sequence,cue:value.number,kind:'single'}) && `${value.number} ${value.name ?? ''} ${value.originalName ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const visibleRefs: ConsoleCueReference[] = selected !== null && sequence ? visibleCues.map(cue => ({ sequence: sequence.sequence, cue: cue.number, kind: 'single' })) : singleRefs;
  const { setPicked } = classification;
  useEffect(() => setPicked([]), [category, selected, query, classification.onlyUnclassified, classification.showRemoved, setPicked]);
  const materialCell = (button: ReactNode, owner: NonNullable<typeof sequence>, cue: string, name: string): JSX.Element => {
    const routes = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === owner.sequence).map(mapping => mapping.executor)) ?? [])];
    const target = owner.sequence === sequence?.sequence ? executor : routes.length === 1 ? routes[0]! : routes.length > 1 ? '__choose' : '';
    const selectedMaterial = owner.sequence === sequence?.sequence && cue === selectedCue;
    const selectedAttributes = selectedMaterial ? attributes : undefined;
    const reference = (): ConsoleCueDrag => ({ sequence: owner.sequence, cue, name, executor: target, attributes: selectedAttributes,
      includeTracking: tracking, valueEdits: selectedMaterial ? editorRef.current?.programEdits() : undefined });
    const usable = selectedAttributes?.length !== 0 && target !== '__choose' && !classification.showRemoved && !material?.library.sourceUnverified;
    return <ConsoleMaterialCell name={name} reference={reference} usable={usable} composing={composing} onUse={onUse} onError={setError}>{button}</ConsoleMaterialCell>;
  };
  const resetSelection = (): void => { setSelected(null); setSingleSequence(null); setSelectedCue(null); setRoute(null); classification.setPicked([]); };
  useEffect(() => { if (pageNavigation) { setCategory('layout'); setSelected(null); setSingleSequence(null); setRoute(null); onBrowseLayout?.(); } }, [pageNavigation, onBrowseLayout]);
  useEffect(() => { setSelected(null); setSingleSequence(null); setSelectedCue(null); setRoute(null); setPicked([]); setError(''); }, [layoutPage.scope, layoutPage.page, setPicked]);
  const openLayout = (): void => {
    setCategory('layout'); resetSelection(); onBrowseLayout?.();
    if (pageKind === 'layout' && !layoutPage.snapshot && !layoutPage.busy) void readMa2LayoutPage(layoutPage.page).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const pageTypeControl = <select aria-label="控台页面类型" value={pageKind === 'layout' ? 'layout' : 'button'} onChange={event => {
    const kind = event.target.value;
    if (kind !== 'button' && kind !== 'fader' && kind !== 'layout') return;
    selectMa2ExecutorPageKind(kind); resetSelection();
    if (kind === 'layout' && !layoutPage.snapshot && !layoutPage.busy) void readMa2LayoutPage(layoutPage.page).catch((cause: unknown) => setError(String(cause)));
  }}><option value="button">执行器</option><option value="layout">Layout 布局</option></select>;
  const openExecutorItem = (item: import('@tb/schema').Ma2ExecutorPage['items'][number], page: number): void => {
    if (!item.sequence) return;
    if (!libraryById.has(item.sequence)) { setError('这一格的序列步骤还没读取，刷新本页后可以编辑'); return; }
    setSelected(item.sequence); setSingleSequence(null); setSelectedCue(null); setRoute(`${page}.${item.slot}`); setQuery('');
  };
  const renderLayoutItem = (item: import('@tb/schema').Ma2LayoutSnapshot['items'][number]): ReactNode => {
    const owner = item.sequence ? libraryById.get(item.sequence) : undefined;
    if (!owner || item.kind === 'other') return query || classification.onlyUnclassified || classification.showRemoved ? null : <button disabled title={owner ? '此对象暂不支持调用' : '此对象不是已读取的序列，请刷新素材目录'}><strong>{item.name || '未读取对象'}</strong><small>{item.kind === 'other' ? '其他对象' : '未读取'}</small></button>;
    const step = item.kind === 'cue' ? owner.cues.find(value => Number(value.number) === Number(item.cue)) : owner.cues.length === 1 ? owner.cues[0] : undefined;
    const name = item.name || (step ? ma2ConsoleCuePoolName(owner, step) : ma2ConsoleSequenceName(owner));
    const ref: ConsoleCueReference = { sequence: owner.sequence, cue: step?.number ?? owner.cues[0]?.number ?? '', kind: step ? 'single' : 'sequence' };
    if (!classification.isVisible(ref) || !`${owner.sequence} ${name} ${owner.cues.map(cue => `${cue.number} ${cue.name}`).join(' ')}`.toLowerCase().includes(query.toLowerCase())) return null;
    const button = <button disabled={!owner.complete || item.kind === 'cue' && !step} aria-label={`页面序列 ${owner.sequence} · ${name}`} aria-pressed={singleSequence === owner.sequence && selectedCue === step?.number} title={`${name} · 序列 ${owner.sequence}${step ? ` · Cue ${Number(step.number)}` : ` · 共 ${owner.cues.length} 步`}`} onContextMenu={event => classification.open(event, ref, name)} onClick={() => {
      if (!step) { setSelected(owner.sequence); setSingleSequence(null); setSelectedCue(null); setRoute(null); setQuery(''); return; }
      setSingleSequence(owner.sequence); setSelectedCue(step.number); if (singleSequence !== owner.sequence) setRoute(null);
      if (!classification.showRemoved) void send('goto', step.number, owner);
    }}><LightingCategoryColors sections={classification.sections.get(consoleCueKey(ref)) ?? []}/>{step ? <Ma2CueCardLabel sequence={owner} cue={step} name={name}/> : <><strong>{name}</strong><small>共 {owner.cues.length} 步</small></>}</button>;
    return step ? materialCell(button, owner, step.number, name) : button;
  };
  const selectedGrid = selected !== null && sequence ? <CuePoolGrid key={`sequence-${sequence.sequence}`} keys={visibleCues.map(value => value.number)} label="序列中的单步灯光" cellWidth={156} rowHeight={50} render={index => {
    const value = visibleCues[index]!;
    const name = ma2ConsoleCueName(value);
    return materialCell(<button title={`序列 ${sequence.sequence} · Cue ${Number(value.number)} · ${name} · 点击试听`} aria-pressed={selectedCue === value.number} aria-label={`试听灯光步 ${value.number}`} onContextMenu={event=>classification.open(event,{sequence:sequence.sequence,cue:value.number,kind:'single'},name)} onClick={event => { classification.select({sequence:sequence.sequence,cue:value.number,kind:'single'},event,visibleCues.map(cue=>({sequence:sequence.sequence,cue:cue.number,kind:'single'})));setSelectedCue(value.number); if(!classification.showRemoved && !event.ctrlKey && !event.metaKey && !event.shiftKey)void send('goto', value.number); }}><LightingCategoryColors sections={classification.sections.get(consoleCueKey({sequence:sequence.sequence,cue:value.number,kind:'single'}))??[]}/><Ma2CueCardLabel sequence={sequence} cue={value} name={name}/></button>, sequence, value.number, name);
  }} /> : null;
  const openEmpty = (): void => { setFiltersOpen(false); setEmptyOpen(true); };
  if (emptyOpen && !timelineOpen) return <Ma2EmptyCuePanel onBack={() => setEmptyOpen(false)}/>;
  return <section className="ma2-sequence-preview" aria-label="MA2 序列预览">
    <header className="ma2-material-menubar" aria-label="控台素材工具栏"><LightingAuditionStop/><div role="group" aria-label="素材分类">{([['all','全部'],['single','单步'],['multi','多步']] as const).map(([value,title])=><button key={value} aria-pressed={!timelineOpen && category===value && selected===null} onClick={()=>{onCloseTimelines?.();setCategory(value);setSelected(null);setSingleSequence(null);setSelectedCue(null);setRoute(null);}}>{title}</button>)}{onBrowseTimelines ? <button aria-pressed={timelineOpen} onClick={() => { setTimelineQuery(''); onBrowseTimelines(); }}>控台时间线</button> : null}{onBrowseLayout ? <button aria-pressed={!timelineOpen && category === 'layout'} onClick={() => { onCloseTimelines?.(); openLayout(); }}>控台页面</button> : null}{onBrowseLayout && <button onClick={openEmpty}>空 Cue</button>}</div>{!timelineOpen && category === 'layout' ? <><div className="ma2-page-toolbar-host" ref={setPageToolbarHost}/></> : null}{!timelineOpen && sequence && <PoolNavigation sequence={sequence} insideSequence={selected !== null} executor={executor} executors={executors} onRoute={setRoute}/>}{!timelineOpen && sequence ? <Ma2CueLocations sequence={sequence.sequence}/> : null}{!timelineOpen ? <Ma2MaterialMenu label="素材筛选" trigger={<ListFilter/>} open={filtersOpen} onOpenChange={setFiltersOpen}>{classification.picked.length>0?<div className="ma2-classification-selection"><span>已选 {classification.picked.length} 项</span><Button variant="secondary" size="sm" onClick={()=>classification.setPicked(visibleRefs)}>全选结果</Button><Button variant="secondary" size="sm" onClick={()=>classification.setPicked([])}>取消选择</Button></div>:null}<p className="ma2-material-menu-label">只显示</p><Button variant="ghost" size="sm" onClick={openEmpty}>仅空 Cue</Button><Button variant="ghost" size="sm" aria-pressed={classification.onlyUnclassified} onClick={()=>classification.setOnlyUnclassified(!classification.onlyUnclassified)}>未分类</Button>{classification.hidden.size?<Button variant="ghost" size="sm" aria-pressed={classification.showRemoved} onClick={()=>{classification.setShowRemoved(!classification.showRemoved);classification.setPicked([]);}}>已移除</Button>:null}</Ma2MaterialMenu> : null}<label className="ma2-pool-search"><Search size={16} /><input aria-label={timelineOpen ? "搜索控台时间线" : "搜索序列或 Cue"} placeholder="搜索名称 / 编号" value={timelineOpen ? timelineQuery : query} onChange={event => timelineOpen ? setTimelineQuery(event.target.value) : setQuery(event.target.value)} /></label>
      <button className="ma2-refresh-directory" aria-label={timelineOpen ? "刷新控台时间线" : "刷新素材目录"} data-busy={materialReading || refreshing} title={timelineOpen ? (timelinesReading ? '正在刷新控台时间线…' : '刷新控台时间线') : materialReading || refreshing ? '正在刷新素材目录…' : '刷新素材目录：重新读取控台上的序列和 Cue 名称'} disabled={attributesBusy || materialReading || timelinesReading || refreshing} onClick={() => void refreshMaterials()}><RefreshCw/></button></header>
    {error || classification.message ? <p className="ma2-material-message" role={error ? 'alert' : 'status'}>{error || classification.message}</p> : null}

    <div className="ma2-material-body"><div className="ma2-material-results">
    {timelineOpen ? <Ma2CachedBrowser embedded query={timelineQuery} onClearSearch={clearTimelineSearch} disabled={refreshing} notify={notify ?? ((text, tone) => { if (tone === 'error') setError(text); })} onClose={() => onCloseTimelines?.()} /> : category === 'layout' && pageKind !== 'layout' ? <Ma2ExecutorPageView toolbarHost={pageToolbarHost} typeControl={pageTypeControl} timecodeSong={document} selected={selected !== null} onBack={resetSelection} onNavigate={resetSelection} onSettings={onLayoutSettings} renderItem={(item, page, band) => <ConsoleExecutorMaterial item={item} owner={item.sequence ? libraryById.get(item.sequence) : undefined} page={page} band={band} query={query} executorInput={executorInput}/>} onEditItem={openExecutorItem}>{selectedGrid}</Ma2ExecutorPageView> : category === 'layout' ? <Ma2LayoutView toolbarHost={pageToolbarHost} typeControl={pageTypeControl} selected={selected !== null} onBack={resetSelection} onNavigate={resetSelection} onSettings={onLayoutSettings} renderItem={renderLayoutItem}>{selectedGrid}</Ma2LayoutView> : selectedGrid}
    {!timelineOpen && selected === null && category !== 'layout' ? <>
      {category === 'single' ? <CuePoolGrid keys={singleKeys} label="素材序列" cellWidth={156} rowHeight={50} render={index=>{
        const {sequence:owner,cue:step}=singles[index]!;
        const name = ma2ConsoleCuePoolName(owner, step);
        return materialCell(<button data-classified={classification.classified.has(consoleCueKey({sequence:owner.sequence,cue:step.number,kind:'single'}))} data-picked={classification.picked.some(ref=>ref.sequence===owner.sequence&&ref.cue===step.number&&ref.kind==='single')} aria-label={`试听序列 ${owner.sequence} 灯光步 ${step.number}`} aria-pressed={singleSequence===owner.sequence&&selectedCue===step.number} title={`${ma2ConsoleSequenceName(owner)} · 序列 ${owner.sequence} · Cue ${Number(step.number)} · ${name}`} onContextMenu={event=>classification.open(event,{sequence:owner.sequence,cue:step.number,kind:'single'},name)} onClick={event=>{classification.select({sequence:owner.sequence,cue:step.number,kind:'single'},event,singleRefs);setSingleSequence(owner.sequence);setSelectedCue(step.number);if(singleSequence!==owner.sequence)setRoute(null);if(!classification.showRemoved && !event.ctrlKey && !event.metaKey && !event.shiftKey)void send('goto',step.number,owner);}}><LightingCategoryColors sections={classification.sections.get(consoleCueKey({sequence:owner.sequence,cue:step.number,kind:'single'}))??[]}/><Ma2CueCardLabel sequence={owner} cue={step} name={name}/></button>,owner,step.number,name);
      }} /> :
      <CuePoolGrid keys={visibleSequences.map(value => String(value.sequence))} label="素材序列" render={index => {
        const value = visibleSequences[index]!;
        const name = ma2ConsoleSequenceName(value);
        return <button aria-label={`${value.sequence} · ${name} · ${value.cues.length} 步`} title={`${value.sequence} · ${name} · ${value.cues.length} 步`} onContextMenu={event=>{const first=value.cues[0];if(first)classification.open(event,{sequence:value.sequence,cue:first.number,kind:value.cues.length===1?'single':'sequence'},name);}} onClick={() => { setSelected(value.sequence); setSelectedCue(null); setRoute(null); setQuery(''); if (!classification.showRemoved && value.complete && value.cues.length === 1) { setSelectedCue(value.cues[0]!.number); void send('goto', value.cues[0]!.number, value); } }}><strong>{name}</strong>{value.cues.length > 1 ? <small className="ma2-sequence-step-count">{`共 ${value.cues.length} 步`}</small> : null}</button>;
      }} />}
      {!(category==='single' ? singles.length : visibleSequences.length) ? <span className="ma2-pool-empty">{library.length ? '无匹配素材' : '还没读取素材'}</span> : null}
    </> : null}
    </div>
    {!timelineOpen && !classification.showRemoved && sequence && activeStep && <Ma2CueAttributePicker key={attributeKey} editorRef={editorRef}
      name={ma2ConsoleCuePoolName(sequence, activeStep)} sequence={sequence.sequence} cue={activeStep.number}
      directory={material?.library.sourceUnverified ? undefined : directory} selection={attributes} initialEdits={currentIngredient?.valueEdits} includeTracking={tracking === true}
      composing={composing} disabled={executor === '__choose' || !!material?.library.sourceUnverified}
      onChange={value => setChoice({key: attributeKey, changed: true, attributes: value})}
      onAdd={(edits, editCurrent) => onUse(sequence.sequence, activeStep.number, ma2ConsoleCuePoolName(sequence, activeStep), executor, attributes, tracking, edits, editCurrent)} />}
    </div>
    {classification.menu}

  </section>;
}

function useMaterialRefresh(timelineOpen: boolean, setError: (message: string) => void) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async (): Promise<void> => {
    setRefreshing(true); setError('');
    try {
      const connection = await ma2MaterialConnection();
      if (timelineOpen) await scanMa2(connection);
      else await scanMa2Materials(connection);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRefreshing(false); }
  };
  return [refreshing, refresh] as const;
}

function ConsoleMaterialCell({ children, name, reference, usable, composing, onUse, onError }: {
  children: ReactNode; name: string; reference: () => ConsoleCueDrag; usable: boolean;
  composing: boolean; onUse: UseConsoleCue; onError: (message: string) => void;
}): JSX.Element {
  return <div className="console-cue-cell" draggable={usable} onDragStart={event => {
    if (!usable) { event.preventDefault(); return; }
    try {
      event.dataTransfer.setData(CONSOLE_CUE_DRAG, JSON.stringify(reference()));
      event.dataTransfer.effectAllowed = 'copy';
    } catch (cause) { event.preventDefault(); onError(cause instanceof Error ? cause.message : String(cause)); }
  }}>
    {children}{composing && <button disabled={!usable} title="加入当前 Cue" aria-label={`添加 ${name} 到当前 Cue`} onClick={() => {
      try {
        const cue = reference();
        onUse(cue.sequence, cue.cue, cue.name, cue.executor, cue.attributes, cue.includeTracking, cue.valueEdits);
      } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    }}><Plus /></button>}
  </div>;
}

function ConsoleExecutorMaterial({item, owner, page, band, query, executorInput}: {
  item: import('@tb/schema').Ma2ExecutorPage['items'][number]; owner: ReturnType<typeof ma2SequenceLibrary>[number] | undefined;
  page: number; band: import('../stores/ma2-executor-page-store').Ma2ExecutorBand; query: string; executorInput: ReturnType<typeof useMa2ExecutorInput>;
}): JSX.Element {
  const step = owner?.cues[0]; const address = `${page}.${item.slot}`;
  const name = item.name || (owner ? ma2ConsoleSequenceName(owner) : '未命名对象');
  const matched = `${name} ${item.slot} ${item.sequence ?? ''}`.toLowerCase().includes(query.toLowerCase());
  const keys = band === 'fader' ? [0, 1, 2] : [0];
  return <div className="ma2-executor-content" onDragStart={event => {
    if (owner && step) event.dataTransfer.setData(CONSOLE_CUE_DRAG, JSON.stringify({ sequence: owner.sequence, cue: step.number, name, executor: address }));
  }}>
    <Ma2ExecutorKey item={item} page={page} index={0} primary matched={matched} input={executorInput}><strong>{name}</strong><small>{owner ? `${owner.cues.length} Cue` : item.kind === 'sequence' ? 'Sequence' : item.reference[0] ?? ''}</small></Ma2ExecutorKey>
    <div className="ma2-executor-functions">{band === 'fader' && item.priority ? <span title="执行器优先级">{item.priority}</span> : null}{keys.map(index => <Ma2ExecutorKey key={index} item={item} page={page} index={index} input={executorInput}/>)}</div>
  </div>;
}

function PoolNavigation({sequence, insideSequence, executor, executors, onRoute}: {
  sequence: ReturnType<typeof ma2SequenceLibrary>[number]; insideSequence: boolean; executor: string; executors: string[]; onRoute: (route: string) => void;
}): JSX.Element {
  return <div className="ma2-pool-navigation"><strong title={`${sequence.sequence} · ${ma2ConsoleSequenceName(sequence)}`}>{ma2ConsoleSequenceName(sequence)}</strong>
        {insideSequence && sequence.cues.length > 1 ? <small className="ma2-sequence-step-count">共 {sequence.cues.length} 步</small> : null}
        <select aria-label="序列预览播放目标" value={executor} onChange={event => onRoute(event.target.value)}>{executors.length > 1 ? <option value="__choose" disabled>选择执行器</option> : null}{executors.map(value => <option key={value} value={value}>执行器 {value}</option>)}<option value="">序列池</option></select>
      </div>;
}
