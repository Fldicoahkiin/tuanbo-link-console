import { LightingCueAttributes } from './LightingCueAttributes';
import type { ConsoleCueReference } from '@tb/core/link';
import { LightingCategoryColors } from './LightingCategoryColors';
import { useDeferredValue, useEffect, useMemo, useState, useRef } from 'react';
import { ArrowLeft, ArrowUp, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { renameLightingLibraryEntryCommand, projectLightingLibrary, setLightingLibraryCommand, setLightingLibraryViewCommand, libraryAffectedSongs, updateLibraryPlacementsCommand, libraryReferenceIssue } from '@tb/core/link';
import { lightingLibraryViewSchema, lightingLibraryEntrySchema, type LightingDocument, type LightingLibraryEntry, type LightingCategory } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { Ma2SequencePreview } from './Ma2SequencePreview';
import { LightingAuditionStop } from './LightingAuditionStop';
import { useAuditionSelectionReset } from '../stores/ma2-audition-store';
import { LightingCueContextMenu } from './LightingCueContextMenu';
import { enableMa2NameSync } from '../runtime/use-ma2-auto-sync';
import { CuePoolGrid } from './CuePoolGrid';
import { EFFECT_DRAG } from './LightingEffectDock';
import '../lighting-classification.css';
import { musicGridOptions } from '../view-models/music-grid-options';

export type LibraryDraft = { sequence: number; cue: string; name: string; executor: string; nativeSequence?: boolean };
export function LightingUserLibrary({ customCategoryId, section, draft, onDraftClose, onBrowse, onAudition, onStamp, onCompose, document, onCueUse, composing = false }: {
  customCategoryId?: string | undefined; composing?: boolean; section: 'front' | 'rim' | 'effect'; document: LightingDocument; onCueUse:(sequence:number,cue:string,name:string,executor:string)=>void;
  draft: LibraryDraft | null; onDraftClose: () => void; onBrowse: () => void;
  onAudition: (id: string) => void; onStamp: (id: string) => void; onCompose: (id: string) => void;
}): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const library = useMemo(() => project ? projectLightingLibrary(project) : null, [project]);
  const [tone, setTone] = useState<'bright'|'middle'|'dark'>(library?.view?.tone ?? 'bright');
  const [selections,setSelections] = useState<Record<'bright'|'middle'|'dark'|'rim',{people:number;zone:'front'|'middle'|'back'}>>(()=>{
    if(library?.view?.selections)return library.view.selections;
    const initial={bright:{people:3,zone:'front' as const},middle:{people:1,zone:'back' as const},dark:{people:1,zone:'back' as const},rim:{people:1,zone:'front' as const}};
    const saved=library?.view;
    if(saved && saved.section!=='effect') {
      const key=saved.section==='rim'?'rim':saved.tone;
      const allowed=key==='bright'?[3,7,12]:key==='middle'?[1,2,3,7]:key==='rim'?[1,3,7,12]:[1];
      if(allowed.includes(saved.people))return {...initial,[key]:{people:saved.people,zone:saved.zone}};
    }
    return initial;
  });
  const selectionKey=section==='rim'?'rim':tone;
  const {people,zone}=selections[selectionKey];
  const setPeople=(people:number):void=>setSelections(current=>({...current,[selectionKey]:{...current[selectionKey],people}}));
  const setZone=(zone:'front'|'middle'|'back'):void=>setSelections(current=>({...current,[selectionKey]:{...current[selectionKey],zone}}));
  const view = 'music'; const [effectCategory, setEffectCategory] = useState(library?.view?.view === 'music' ? library.view.effectCategory : 'effect:music:0');
  const [scope, setScope] = useState<string>(customCategoryId ? 'category' : library?.view?.scope ?? 'category'); const [query, setQuery] = useState(library?.view?.query ?? ''); const deferred = useDeferredValue(query);
  const [selected, setSelected] = useState<string[]>([]); const [editing, setEditing] = useState<LightingLibraryEntry | null>(null);
  useAuditionSelectionReset(()=>setSelected([]));
  const [updateBase, setUpdateBase] = useState<Record<string,LightingDocument>>({});
  const [updateId, setUpdateId] = useState<string | null>(null); const [updateSongs, setUpdateSongs] = useState<string[]>([]);
  const [attributes,setAttributes]=useState<{refs:ConsoleCueReference[];title:string}|null>(null);
  const [context,setContext]=useState<{x:number;y:number;ids:string[];name:string}|null>(null);
  const [opened, setOpened] = useState<string | null>(null); const [error, setError] = useState(''); const [manage, setManage] = useState(false);
  const persistView = (): void => {
    if(!project)return;
    const state=useDocumentStore.getState();if(state.project?.projectId!==project.projectId)return;
    const next=lightingLibraryViewSchema.parse({section,tone,people,zone,view,effectCategory,scope,query,selections});
    if(JSON.stringify(next)===JSON.stringify(projectLightingLibrary(state.project).view))return;
    state.execute(setLightingLibraryViewCommand(next));
  };
  const flush=useRef(persistView);
  useEffect(()=>{flush.current=persistView;});
  useEffect(()=>()=>{try{flush.current();}catch(cause){console.error('保存分类浏览位置失败',cause);}},[]);
  const categories = library?.categories ?? [];
  const categoryId = customCategoryId ?? (section === 'front' ? `front:${tone}:${people}:${zone}` : section === 'rim' ? `rim:${people}:${zone}` : effectCategory);
  const index = useMemo(() => library?.entries.map(entry => ({ entry, text: `${entry.name} ${entry.originalName} ${entry.track.cueStamp?.mode === 'fixed' ? `${entry.track.cueStamp.sequence} ${entry.track.cueStamp.cue}` : ''}`.toLocaleLowerCase() })) ?? [], [library]);
  const visible = useMemo(() => index.filter(({ entry, text }) => text.includes(deferred.toLocaleLowerCase()) && (scope === 'all' || scope === 'favorites' && entry.favorite || scope === 'unclassified' && !entry.categoryIds.length || scope === 'category' && entry.categoryIds.includes(categoryId))).map(value => value.entry), [index, deferred, scope, categoryId]);
  if (!library || !project) return <div>请先打开工程</div>;
  const commit = (entries: LightingLibraryEntry[], nextCategories = library.categories, label = '整理灯光分类'): void => {
    try { useDocumentStore.getState().execute(setLightingLibraryCommand({ ...library, categories: nextCategories, entries }, label)); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const beginUpdate = (id: string): void => { const current=useDocumentStore.getState().project; setUpdateBase(Object.fromEntries(current?.rundown.flatMap(item=>item.lighting ? [[item.id,item.lighting]] : []) ?? []));setUpdateId(id);setUpdateSongs([]); };
  const active = library.entries.find(entry => entry.id === opened);
  const performEntry = (entry: LightingLibraryEntry, action: () => void): void => { const issue = libraryReferenceIssue(project, entry); if (issue) setError(issue); else { setError(''); action(); } };
  const source = project.ma2MaterialLibrary;
  const legacyMenus = (localStorage.getItem('lighting-material-menus') ?? '').split('\n').filter(name=>name.trim() && !library.categories.some(category=>category.name===name));
  const save = (form: HTMLFormElement): void => {
    try {
      const values = new FormData(form); const name = formText(values, 'name').trim();
      const old = editing; const binding = old?.track.cueStamp;
      const sequence = Number(values.get('sequence')); const cue = formText(values, 'cue'); const executor = formText(values, 'executor').trim();
      const rebind = values.has('rebind');
      const nextSource = rebind || !old ? { endpoint: source?.library ? source.source : '', show: source?.library?.directory.show ?? '', verified: Boolean(source?.library && !source.library.sourceUnverified) } : old.source;
      const changed = old && (old.source.show !== nextSource.show || old.source.endpoint !== nextSource.endpoint || (binding?.mode !== 'fixed' || sequence !== binding.sequence || cue !== binding.cue || executor !== binding.executor));
      const entry = lightingLibraryEntrySchema.parse({ ...old, id: old?.id ?? crypto.randomUUID(), name, originalName: old?.originalName ?? draft?.name ?? name,
        revision: (old?.revision ?? 1) + (changed ? 1 : 0), kind: old?.kind ?? (draft?.nativeSequence ? 'sequence' : 'single'), favorite: old?.favorite ?? false,
        source: nextSource,
        categoryIds: values.getAll('category').map(String), track: { ...(old?.track ?? { id: crypto.randomUUID(), kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] }), name, cueStamp: { mode: 'fixed', sequence, cue, executor } }
      });
      if (rebind) { const issue = libraryReferenceIssue(project,entry); if (issue) throw new Error(issue); }
      useDocumentStore.getState().execute(setLightingLibraryCommand({ ...library, entries: [...library.entries.filter(value => value.id !== entry.id), entry] }, '保存分类 Cue'));
      setEditing(null); onDraftClose(); setError(''); if (changed) beginUpdate(entry.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="lighting-classification" data-composing={composing} data-section={section} aria-label="我的灯光分类" onBlurCapture={event=>{if(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))return;try{persistView();}catch(cause){setError(cause instanceof Error ? cause.message : String(cause));}}}>
    <nav className="classification-searchbar" aria-label="素材搜索"><LightingAuditionStop/>
      <label className="classification-search"><Search /><input aria-label="搜索分类 Cue" placeholder="名称 / 编号" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="分类搜索范围" value={scope} onChange={event => setScope(event.target.value)}><option value="category">当前分类</option><option value="all">全部分类</option><option value="favorites">收藏</option><option value="unclassified">未分类</option></select>
    </nav>
    {customCategoryId ? <strong>{categories.find(category=>category.id===customCategoryId)?.name}</strong> : <nav className="classification-submenu" aria-label="灯光素材子菜单">
      {section === 'front' ? <div className="classification-filter-group" data-filter="tone" role="group" aria-label="面光调性">{([['bright','亮调'],['middle','中调'],['dark','暗调']] as const).map(([key,name])=><button key={key} data-tone={key} aria-pressed={tone===key} onClick={()=>{setTone(key);setScope('category');setOpened(null);}}>{name}</button>)}</div> : null}
      {section !== 'effect' ? <><div className="classification-filter-group" data-filter="zone" role="group" aria-label="灯光区域">{([['front','前区'],['middle','中区'],['back','后区']] as const).map(([key,name])=><button key={key} data-zone={key} aria-pressed={zone===key} onClick={()=>setZone(key)}>{name}</button>)}</div><div className="classification-filter-group" data-filter="people" role="group" aria-label="人数">{(section==='rim'?[1,3,7,12]:tone==='bright'?[3,7,12]:tone==='middle'?[1,2,3,7]:[1]).map(value=><button key={value} aria-pressed={people===value} onClick={()=>setPeople(value)}>{value}人</button>)}</div></> : <><div className="effect-menu-column" role="group" aria-label="音乐用途"><span>音乐用途</span>{categories.filter(value=>value.section==='effect'&&value.view==='music').map(value=><button key={value.id} aria-pressed={effectCategory===value.id} onClick={()=>setEffectCategory(value.id)}>{value.name}</button>)}</div><div className="effect-menu-column" role="group" aria-label="节拍灯光"><span>节拍灯光</span>{categories.filter(value=>value.section==='effect'&&value.view==='beat').map(value=>{const option=musicGridOptions(document,document.music?.firstBeatMs??0).find(option=>option.value===value.beats);return <button key={value.id} aria-pressed={effectCategory===value.id} title={option?.label} onClick={()=>setEffectCategory(value.id)}>{value.name}</button>;})}</div><button title="管理效果分类" aria-label="管理效果分类" onClick={()=>setManage(!manage)}><Settings2 />管理分类</button></>}
    </nav>}
    <div className="classification-filters"><span>{visible.length} 项</span><button onClick={onBrowse}><Plus />从控台添加</button>{selected.length>1?<><span>已选 {selected.length} 项</span><button onClick={()=>setSelected([])}>取消选择</button></>:null}</div>
    {context?<LightingCueContextMenu {...context} title={context.ids.length>1?`已选 ${context.ids.length} 个 Cue`:context.name} categories={categories} navigation={library.navigation} categoryIds={categories.filter(category=>context.ids.every(id=>library.entries.find(entry=>entry.id===id)?.categoryIds.includes(category.id))).map(category=>category.id)} mixedCategoryIds={categories.filter(category=>context.ids.some(id=>library.entries.find(entry=>entry.id===id)?.categoryIds.includes(category.id))&&!context.ids.every(id=>library.entries.find(entry=>entry.id===id)?.categoryIds.includes(category.id))).map(category=>category.id)} onClose={()=>setContext(null)} onAttributes={()=>setAttributes({title:context.name,refs:context.ids.flatMap(id=>{const entry=library.entries.find(value=>value.id===id);if(!entry)return [];const refs=entry.members??(entry.track.cueStamp?.mode==='fixed'?[entry.track.cueStamp]:[]);return refs.map(ref=>({sequence:ref.sequence,cue:ref.cue,kind:entry.kind==='sequence'?'sequence' as const:'single' as const}));})})} onRename={context.ids.length===1?async(name)=>{const state=useDocumentStore.getState();if(state.project?.projectId!==project.projectId)throw new Error('工程已切换，请重新选择 Cue');state.execute(renameLightingLibraryEntryCommand(context.ids[0]!,name));if(library.entries.find(entry=>entry.id===context.ids[0])?.kind!=='combination')await enableMa2NameSync(state.documentId);}:undefined} renamesOnConsole={context.ids.length===1&&library.entries.find(entry=>entry.id===context.ids[0])?.kind!=='combination'} onConfirm={changes=>{commit(library.entries.map(entry=>context.ids.includes(entry.id)?{...entry,categoryIds:[...new Set([...entry.categoryIds.filter(id=>!changes.remove.includes(id)),...changes.add])]}:entry));setSelected([]);}} onRemove={()=>{commit(scope==='category'?library.entries.map(entry=>context.ids.includes(entry.id)?{...entry,categoryIds:entry.categoryIds.filter(id=>id!==categoryId)}:entry):library.entries.filter(entry=>!context.ids.includes(entry.id)),library.categories,'移除分类 Cue');setSelected([]);}} onAdd={context.ids.length===1?()=>{const entry=library.entries.find(entry=>entry.id===context.ids[0]);if(entry)performEntry(entry,()=>onStamp(entry.id));}:undefined}/>:null}
    {attributes?<LightingCueAttributes {...attributes} onClose={()=>setAttributes(null)}/>:null}
    {legacyMenus.length ? <details><summary>待整理的本机分类 · {legacyMenus.length}</summary><span>{legacyMenus.join(' / ')}</span><button onClick={()=>commit(library.entries,[...library.categories,...legacyMenus.map(name=>({id:crypto.randomUUID(),section:'effect' as const,view:'shape' as const,name}))],'整理历史分类')}>归入当前工程的效果分类</button></details> : null}
    {manage ? <CategoryManager categories={categories} view={view} onChange={next => commit(library.entries.map(entry => ({ ...entry, categoryIds: entry.categoryIds.filter(id => next.some(value => value.id === id)) })), next)} /> : null}
    {error ? <p role="alert">{error}</p> : null}
    {updateId ? <div className="classification-update"><strong>选择需要更新的歌曲</strong>{libraryAffectedSongs(project, library.entries.find(entry => entry.id === updateId)!).map(song => <label key={song.itemId}><input type="checkbox" checked={updateSongs.includes(song.itemId)} onChange={event => setUpdateSongs(current => event.target.checked ? [...current, song.itemId] : current.filter(id => id !== song.itemId))} />{song.title} · {song.positions.length} 处 · {song.positions.map(ms => `${(ms / 1000).toFixed(3)}s`).join('、')}<small>原：{song.previous.join('；')} → 新：{song.next.join('；')}</small></label>)}<button disabled={!updateSongs.length} onClick={() => { try { const entry = library.entries.find(value => value.id === updateId)!; useDocumentStore.getState().execute(updateLibraryPlacementsCommand(entry.id, entry.revision, updateSongs, updateBase)); setUpdateId(null); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>更新所选歌曲</button><button onClick={() => setUpdateId(null)}>保留歌曲原版本</button></div> : null}
    {editing || draft ? <form className="classification-editor" onSubmit={event => { event.preventDefault(); save(event.currentTarget); }} key={editing?.id ?? `${draft?.sequence}:${draft?.cue}`}>
      <label>名称<input name="name" required defaultValue={editing?.name ?? draft?.name ?? ''} /></label>
      <label>序列<input name="sequence" readOnly={editing?.kind === 'combination'} type="number" min="1" max="99999" required defaultValue={editing?.track.cueStamp?.mode === 'fixed' ? editing.track.cueStamp.sequence : draft?.sequence} /></label>
      <label>Cue<input name="cue" readOnly={editing?.kind === 'combination'} required defaultValue={editing?.track.cueStamp?.mode === 'fixed' ? editing.track.cueStamp.cue : draft?.cue} /></label>
      <label>执行器<input name="executor" readOnly={editing?.kind === 'combination'} placeholder="序列池可留空" defaultValue={editing?.track.cueStamp?.mode === 'fixed' ? editing.track.cueStamp.executor : draft?.executor} /></label>
      <label><input name="rebind" type="checkbox" />核对并采用当前控台的引用</label><fieldset><legend>所属分类</legend>{categories.filter(category=>category.custom||category.view!=='shape'||editing?.categoryIds.includes(category.id)).map(category => <label key={category.id}><input type="checkbox" name="category" value={category.id} defaultChecked={editing ? editing.categoryIds.includes(category.id) : category.id === categoryId} />{category.section === 'effect' ? `${category.view === 'beat' ? '节拍' : category.view === 'music' ? '音乐' : '历史'} · ` : category.section === 'front' ? '面光 · ' : '轮廓 · '}{category.name}</label>)}</fieldset>
      <footer>{editing ? <><button type="button" onClick={() => { beginUpdate(editing.id); setEditing(null); }}>查看歌曲更新</button><button type="button" onClick={() => { commit(library.entries.filter(value => value.id !== editing.id)); setEditing(null); }}>从素材库移除</button></> : null}<button type="button" onClick={() => { setEditing(null); onDraftClose(); }}>取消</button><button>保存分类 Cue</button></footer>
    </form> : active ? <div className="classification-detail"><button onClick={() => setOpened(null)}><ArrowLeft />返回</button><strong title={active.name}>{active.name}</strong><button onClick={() => performEntry(active, () => onAudition(active.id))}>试听</button><button onClick={() => performEntry(active, () => onStamp(active.id))}>添加到播放头</button>{active.kind==='combination' ? <button onClick={() => onCompose(active.id)}>编辑组合</button> : null}{active.kind === 'sequence' && active.track.cueStamp?.mode === 'fixed' ? <Ma2SequencePreview document={document} initialSequence={active.track.cueStamp.sequence} initialExecutor={active.track.cueStamp.executor} onClose={() => setOpened(null)} onUse={onCueUse} /> : null}<ol>{active.members?.map((member, index) => <li key={index}>{member.name} · {member.sequence} / {member.cue} · +{member.delayMs}ms</li>)}</ol></div> : <CuePoolGrid cellWidth={148} rowHeight={34} keys={visible.map(entry => entry.id)} label="分类 Cue" render={index => {
      const entry = visible[index]!; const binding = entry.track.cueStamp;
      return <div className="classification-cell" data-selected={selected.includes(entry.id)} onContextMenu={event=>{event.preventDefault();event.stopPropagation();const ids=selected.includes(entry.id)?selected:[entry.id];setSelected(ids);setContext({x:event.clientX,y:event.clientY,ids,name:entry.name});}}><button draggable title={`${entry.name} · ${entry.originalName}${binding?.mode === 'fixed' ? ` · ${binding.sequence} / ${binding.cue}` : ''}`} onDragStart={event => { event.dataTransfer.setData(EFFECT_DRAG, entry.id); event.dataTransfer.effectAllowed = 'copy'; }} onClick={event => {setSelected(current=>event.ctrlKey||event.metaKey?current.includes(entry.id)?current.filter(id=>id!==entry.id):[...current,entry.id]:[entry.id]);performEntry(entry, () => onAudition(entry.id));}}><LightingCategoryColors sections={categories.filter(category=>entry.categoryIds.includes(category.id)).map(category=>category.section)}/><strong>{entry.name}</strong>{libraryReferenceIssue(project, entry) ? <span className="classification-reference-dot" aria-label="待核对" title={libraryReferenceIssue(project, entry) ?? undefined} /> : null}</button><button title={composing ? '加入当前 Cue' : '添加到播放头'} aria-label={`添加 ${entry.name} ${composing ? '到当前 Cue' : '到播放头'}`} onClick={() => performEntry(entry, () => onStamp(entry.id))}><Plus /></button></div>;
    }} />}
  </section>;
}

function CategoryManager({ categories, view, onChange }: { categories: LightingCategory[]; view: 'music' | 'shape'; onChange: (categories: LightingCategory[]) => void }): JSX.Element {
  return <div className="classification-category-manager">{categories.filter(value => value.view === view).map(category => <div key={category.id}><input aria-label="分类名称" defaultValue={category.name} onBlur={event => { const name = event.currentTarget.value.trim(); if (name && name !== category.name) onChange(categories.map(value => value.id === category.id ? { ...value, name } : value)); }} /><button title="上移分类" onClick={() => { const next = [...categories]; const index = next.indexOf(category); const previous = next.map((value, position) => position < index && value.view === view ? position : -1).filter(position => position >= 0).at(-1) ?? -1; if (previous >= 0) { [next[previous], next[index]] = [next[index]!, next[previous]!]; onChange(next); } }}><ArrowUp /></button><button aria-label={`删除分类 ${category.name}`} onClick={() => onChange(categories.filter(value => value.id !== category.id))}><Trash2 /></button></div>)}<button onClick={() => onChange([...categories, { id: crypto.randomUUID(), section: 'effect', view, name: '新分类' }])}><Plus />添加分类</button></div>;
}

function formText(data: FormData, name: string): string { const value = data.get(name); if (typeof value !== "string") throw new Error("表单字段无效"); return value; }
