import { Ma2SongSequencePanel } from './Ma2SongSequencePanel';
import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Settings2, X, Trash2 } from 'lucide-react';
import { ma2LayoutSettingsSchema, type Ma2LayoutSnapshot, type Ma2LayoutSettings } from '@tb/schema';
import { mergeMa2AttributesCommand, projectLightingLibrary, setLightingLibraryCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { acceptCreatedMa2Layout, currentMa2LayoutScope, readMa2LayoutPage } from '../stores/ma2-layout-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { CONSOLE_CUE_DRAG, consoleCueDragSchema } from './lighting-material-drag';
import { ma2ConsoleSequenceName, ma2ConsoleCuePoolName, ma2SequenceLibrary } from '../view-models/ma2-sequence-library';
import { CuePoolGrid } from './CuePoolGrid';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import { Ma2SequencePreview } from './Ma2SequencePreview';
import type { LightingDocument } from '@tb/schema';
import type { CueIngredient } from './LightingCueComposer';
import '../ma2-layout.css';

export function Ma2LayoutPanel({ itemId, document, ingredients, onIngredients, onClose }: { itemId: string; document: LightingDocument; ingredients: CueIngredient[]; onIngredients: (value: CueIngredient[]) => void; onClose: () => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const saved = project ? projectLightingLibrary(project).consoleWorkspace : undefined;
  const [settingsDraft, setSettingsDraft] = useState<Partial<Ma2LayoutSettings>>({});
  const settings: Ma2LayoutSettings = { layout: 999, name: '联动台新建 Cue', nextSequence: 9000, columns: 8, ...saved, ...settingsDraft };
  const [layout, setLayout] = useState<Ma2LayoutSnapshot | null>(null);
  const [mode, setMode] = useState<'combine' | 'programmer'>('combine');
  const [use, setUse] = useState<'Active' | 'Look'>('Active');
  const [name, setName] = useState('');
  const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [creating, setCreating] = useState(false);
  const [sequence, setSequence] = useState<number | null>(null);
  const library = useMemo(() => ma2SequenceLibrary(project, document), [project,document]);
  const prepare = async () => {
    const state=useDocumentStore.getState();const pool=state.project?.ma2MaterialLibrary;
    if(!state.project || !pool?.library || pool.library.sourceUnverified)throw new Error('请先读取并核对控台素材');
    const connection=await ma2MaterialConnection();
    if(!connection.network)throw new Error('Layout 和新建 Cue 需要使用 MA2 网络连接；请在设备设置连接控台 IP');
    const endpoint=`${connection.network.host}:${connection.network.port}`;
    if(endpoint!==pool.source)throw new Error('当前连接与素材来源不同，请重新读取控台');
    const {show,generation,version}=pool.library.directory;
    return {state,network:connection.network,expectedSource:{show,generation,version},endpoint};
  };
  const read = async (): Promise<void> => {
    setBusy(true);setError('');setMessage('正在读取 Layout');
    try {
      const value=await readMa2LayoutPage(settings.layout);
      setLayout(value);setSequence(null);setMessage(`Layout ${value.layout} · ${value.items.length} 个对象${value.omittedFixtures?` · ${value.omittedFixtures} 个灯具符号未显示`:''}`);
    } catch(cause){setError(cause instanceof Error?cause.message:String(cause));setMessage('');}
    finally{setBusy(false);}
  };
  const create = async (): Promise<void> => {
    setBusy(true);setError('');setMessage('正在检查空编号并创建 Cue');
    try {
      const parsed=ma2LayoutSettingsSchema.parse(settings);const context=await prepare();const current=context.state;const layoutScope=currentMa2LayoutScope();
      if(!current.project)throw new Error('工程已关闭');
      if(mode==='combine' && ingredients.some(value=>value.delayMs!==0))throw new Error('静态合成 Cue 不包含时间延迟；带延迟的组合请保留在本地编排');
      current.execute(setLightingLibraryCommand({...projectLightingLibrary(current.project),consoleWorkspace:parsed},'设置控台专用 Layout'));
      const before=useDocumentStore.getState();if(!before.project)throw new Error('工程已关闭');
      const path=await linkDesktopViewModel.saveProject(before.path,before.project);
      if(!path)throw new Error('请先保存工程');
      if(useDocumentStore.getState().documentId!==before.documentId)throw new Error('工程已切换');
      before.markSaved(path,before.stateId,before.documentId);
      const result=await window.tbLink.createMa2Cue({network:context.network,expectedSource:context.expectedSource,projectId:before.project.projectId,requestId:crypto.randomUUID(),settings:parsed,name,content:mode==='combine'?{kind:'combine',cues:ingredients.map(value=>({sequence:value.sequence,cue:value.cue}))}:{kind:'programmer',use}});
      const after=useDocumentStore.getState();
      if(after.documentId!==before.documentId||!after.project)throw new Error('控台已创建，但工程已切换，请重新读取控台');
      after.executeForDocument(before.documentId,mergeMa2AttributesCommand(context.endpoint,result.library,[result.sequence],false));
      const updated=useDocumentStore.getState();if(!updated.project)throw new Error('工程已关闭');
      const nextSettings={...parsed,nextSequence:Math.min(99999,result.sequence+1)};
      updated.executeForDocument(before.documentId,setLightingLibraryCommand({...projectLightingLibrary(updated.project),consoleWorkspace:nextSettings},'记录新建 Cue 位置'));
      const latest=useDocumentStore.getState();if(!latest.project)throw new Error('工程已关闭');
      const savedPath=await linkDesktopViewModel.saveProject(path,latest.project);
      if(!savedPath)throw new Error('控台已创建，工程保存未完成');
      latest.markSaved(savedPath,latest.stateId,before.documentId);
      acceptCreatedMa2Layout(layoutScope,result.layout);
      setLayout(result.layout);setSettingsDraft({});setMessage(`“${name}”已创建：序列 ${result.sequence} · Cue 1 · Layout ${result.layout.layout}，回读已确认`);setName('');onIngredients([]);setCreating(false);
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));setMessage('');}
    finally{setBusy(false);}
  };
  return <aside className="ma2-layout-panel" aria-label="控台 Layout" onDragOver={event=>{if(event.dataTransfer.types.includes(CONSOLE_CUE_DRAG))event.preventDefault();}} onDrop={event=>{event.preventDefault();try{const value=consoleCueDragSchema.parse(JSON.parse(event.dataTransfer.getData(CONSOLE_CUE_DRAG)));onIngredients([...ingredients,{...value,delayMs:0}]);setCreating(true);}catch(cause){setError(String(cause));}}}>
    <header><strong>新建与同步</strong><button onClick={()=>setCreating(!creating)} disabled={busy}><Plus/>新建 Cue</button><button aria-label="关闭 Layout" onClick={onClose} disabled={busy}><X/></button></header>
    <Ma2SongSequencePanel itemId={itemId} settings={settings}/>
    <details><summary><Settings2/>专用页面设置</summary><div className="ma2-layout-settings">
      <label>Layout 编号<input aria-label="专用 Layout 编号" type="number" min="1" max="9999" value={settings.layout} disabled={busy} onChange={event=>{setSettingsDraft({...settingsDraft,layout:Number(event.target.value)});setLayout(null);}}/></label>
      <label>新布局名称<input value={settings.name} disabled={busy} onChange={event=>setSettingsDraft({...settingsDraft,name:event.target.value})}/></label>
      <label>起始序列编号<input aria-label="新建 Cue 序列编号" type="number" min="1" max="99999" value={settings.nextSequence} disabled={busy} onChange={event=>setSettingsDraft({...settingsDraft,nextSequence:Number(event.target.value)})}/></label>
      <label>每行按钮数<input type="number" min="1" max="24" value={settings.columns} disabled={busy} onChange={event=>setSettingsDraft({...settingsDraft,columns:Number(event.target.value)})}/></label>
    </div><p>第一次新建请选择空 Layout。只追加到本工程创建的专用布局；原有布局可以读取查看。</p></details>
    <div className="ma2-layout-read"><label>查看 Layout<input aria-label="查看 Layout 编号" type="number" min="1" max="9999" value={settings.layout} disabled={busy} onChange={event=>{setSettingsDraft({...settingsDraft,layout:Number(event.target.value)});setLayout(null);}}/></label><button onClick={()=>void read()} disabled={busy}><RefreshCw/>读取页面</button></div>
    {creating ? <form className="ma2-layout-create" onSubmit={event=>{event.preventDefault();void create();}}><label>Cue 名称<input aria-label="新建控台 Cue 名称" value={name} required maxLength={512} disabled={busy} onChange={event=>setName(event.target.value)}/></label><Ma2ConsoleName name={name}/><select aria-label="新建 Cue 方式" value={mode} disabled={busy} onChange={event=>setMode(event.target.value==='combine'?'combine':'programmer')}><option value="combine">组合已有 Cue</option><option value="programmer">保存控台当前灯光</option></select>
      {mode==='combine'?<><p>拖入素材或点击素材旁的 +。只合成已保存属性；重叠属性按下面顺序由后者覆盖，不包含延迟或多步运行过程。</p><ol>{ingredients.map((value,index)=><li key={index}><span>{value.name} <small>{value.sequence} / {value.cue}</small></span><button type="button" aria-label={`移除组合素材 ${index+1}`} disabled={busy} onClick={()=>onIngredients(ingredients.filter((_,i)=>i!==index))}><Trash2/></button></li>)}</ol></>:<><select aria-label="保存当前灯光范围" value={use} disabled={busy} onChange={event=>setUse(event.target.value==='Look'?'Look':'Active')}><option value="Active">Programmer 中已激活的属性</option><option value="Look">当前可见灯光（Look）</option></select><p>使用控台当前 World 和 Store Filter，保留 Programmer 激活状态。</p></>}
      <button type="submit" disabled={busy||!name.trim()||mode==='combine'&&!ingredients.length}>{busy?'正在创建并回读…':`创建到 Layout ${settings.layout}`}</button></form>:null}
    {layout ? <><strong>{layout.name || `Layout ${layout.layout}`}</strong><CuePoolGrid keys={layout.items.map(item => item.id)} label="本页控台素材" cellWidth={156} rowHeight={50} render={index => {
      const item = layout.items[index]!; const owner = library.find(value => value.sequence === item.sequence);
      const title = owner ? ma2ConsoleSequenceName(owner) : item.name || '未关联对象';
      return <button disabled={item.kind !== 'sequence' || !owner} title={`${title} · 序列 ${item.sequence}`} onClick={() => setSequence(item.sequence ?? null)}><strong>{title}</strong>{owner ? <small>共 {owner.cues.length} 步</small> : null}</button>;
    }}/></> : <p>输入 Layout 编号并读取本页 Cue。</p>}
    {sequence!==null?<Ma2SequencePreview key={sequence} document={document} initialSequence={sequence} composing onClose={()=>setSequence(null)} onUse={(seq,cue,label,executor)=>{const owner=library.find(value=>value.sequence===seq);const step=owner?.cues.find(value=>value.number===cue);onIngredients([...ingredients,{sequence:seq,cue,name:owner&&step?ma2ConsoleCuePoolName(owner,step):label,executor,delayMs:0}]);setCreating(true);}}/>:null}
    {error?<p role="alert">{error}</p>:<p role="status">{message}</p>}
  </aside>;
}
