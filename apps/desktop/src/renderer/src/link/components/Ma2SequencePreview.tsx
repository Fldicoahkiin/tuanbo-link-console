import { LightingCategoryColors } from './LightingCategoryColors';
import { LightingAuditionStop } from './LightingAuditionStop';
import { useAuditionSelectionReset } from '../stores/ma2-audition-store';
import { useDocumentStore } from '../stores/document-store';
import { loadMa2MaterialCache } from './ma2-material-cache';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Search, AlertCircle, Plus } from 'lucide-react';
import type { LightingDocument, Ma2PlaybackAction, Ma2PreviewState } from '@tb/schema';
import { LightingCueAudition } from '../../registry/lighting-cue-audition';
import '../ma2-sequence-preview.css';

import { useConsoleCueClassification } from './useConsoleCueClassification';
import { consoleCueKey, type ConsoleCueReference } from '@tb/core/link';
import { CuePoolGrid } from './CuePoolGrid';
import { CONSOLE_CUE_DRAG } from './lighting-material-drag';
import { ma2SequenceLibrary } from '../view-models/ma2-sequence-library';
export function Ma2SequencePreview({ document, initialSequence, initialExecutor, onUse, composing = false }: { composing?: boolean; initialSequence?: number; initialExecutor?: string; onClassify?: (value: import('./LightingUserLibrary').LibraryDraft) => void; document: LightingDocument; onUse: (sequence: number, cue: string, name: string, executor: string) => void; onClose: () => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const material = project ? loadMa2MaterialCache(project.projectId) : null;
  const [output] = useState(() => new LightingCueAudition());
  const [selected, setSelected] = useState<number | null>(initialSequence ?? null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'single' | 'multi'>('single');
  const [singleSequence,setSingleSequence]=useState<number|null>(null);
  const [route, setRoute] = useState<string | null>(initialExecutor ?? null);
  const [preview, setPreview] = useState<Ma2PreviewState>({ selectedCue: null, command: 'idle', activity: { state: 'unsupported', reason: '尚未验证此控台版本的活动 Cue 回读接口' } });
  const selectedCue = preview.selectedCue;
  const setSelectedCue = (selectedCue: string | null): void => setPreview(current => ({ ...current, selectedCue }));
  const [status, setStatus] = useState('选择序列，点击灯光步试听；继续播放沿用控台编排');
  const [error, setError] = useState('');
  const classification=useConsoleCueClassification(setError);
  useAuditionSelectionReset(()=>{setSelectedCue(null);classification.setPicked([]);});
  const [busy, setBusy] = useState(false);
  useEffect(() => () => output.cancel(), [output]);
  const library = useMemo(() => ma2SequenceLibrary(project, document), [project, document]);
  const index = useMemo(() => library.map(value => ({ value, text: `${value.sequence} ${value.name ?? ''} ${value.originalName ?? ''} ${value.cues.map(cue => `${cue.number} ${cue.name ?? ''} ${cue.originalName ?? ''}`).join(' ')}`.toLowerCase() })), [library]);
  const matchingSequences = useMemo(() => index.filter(({value,text}) => text.includes(query.toLowerCase()) && (category !== 'multi' || value.cues.length > 1)).map(entry=>entry.value),[index,query,category]);
  const visibleSequences=matchingSequences.filter(value=>classification.isVisible({sequence:value.sequence,cue:value.cues[0]?.number??'',kind:value.cues.length===1?'single':'sequence'}));
  const allSingles = useMemo(()=>library.flatMap(sequence=>sequence.cues.filter(cue=>`${sequence.sequence} ${sequence.name ?? ''} ${sequence.originalName ?? ''} ${cue.number} ${cue.name ?? ''} ${cue.originalName ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(cue=>({sequence,cue}))),[library,query]);
  const singles=allSingles.filter(({sequence,cue})=>classification.isVisible({sequence:sequence.sequence,cue:cue.number,kind:'single'}));
  const singleRefs:ConsoleCueReference[]=singles.map(({sequence,cue})=>({sequence:sequence.sequence,cue:cue.number,kind:'single'}));
  const sequence = library.find(value=>value.sequence===(selected ?? singleSequence));
  const executors = sequence ? [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === sequence.sequence).map(mapping => mapping.executor)) ?? [])] : [];
  const executor = route ?? (executors.length === 1 ? executors[0]! : executors.length > 1 ? '__choose' : '');
  const send = async (action: Ma2PlaybackAction['action'], number?: string, chosen = sequence): Promise<void> => {
    if (!chosen || busy) return;
    if (material?.library.sourceUnverified && action !== 'off') { setError('素材来源尚未核对，请在读取素材中补读未完成项；已读步骤可继续查看'); return; }
    const routes = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === chosen.sequence).map(mapping => mapping.executor)) ?? [])];
    const destination = chosen.sequence === sequence?.sequence ? executor : routes.length === 1 ? routes[0]! : '';
    if (destination === '__choose' || routes.length > 1 && (chosen.sequence !== sequence?.sequence || route === null)) { setError('此序列有多个执行器，请先明确选择播放目标'); return; }
    const target = destination ? `执行器 ${destination}` : `序列 ${chosen.sequence}`;
    const operation = action === 'goto' ? `调用灯光步 ${number}` : action === 'go' ? '继续播放' : '关闭输出';
    setPreview(current => ({ ...current, command: 'sending' }));
    setBusy(true); setError(''); setStatus(`正在发送${operation} · ${target}`);
    try {
      const sent = await output.playAction(destination ? { target: 'executor', executor: destination, action, ...(number ? { cue: number } : {}) } : { target: 'sequence', sequence: chosen.sequence, action, ...(number ? { cue: number } : {}) });
      setPreview(current => ({ ...current, command: sent ? 'sent' : 'idle' }));
      if (sent) setStatus(`已发送${operation} · ${target}；当前播放步未回读`);
    } catch (cause) { setPreview(current => ({ ...current, command: 'failed' })); const message = cause instanceof Error ? cause.message : String(cause); setError(message); setStatus('发送未完成'); }
    finally { setBusy(false); }
  };
  const visibleCues = sequence?.cues.filter(value => classification.isVisible({sequence:sequence.sequence,cue:value.number,kind:'single'}) && `${value.number} ${value.name ?? ''} ${value.originalName ?? ''}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const materialCell = (button: ReactNode, owner: NonNullable<typeof sequence>, cue: string, name: string): JSX.Element => {
    const routes = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === owner.sequence).map(mapping => mapping.executor)) ?? [])];
    const target = owner.sequence === sequence?.sequence ? executor : routes.length === 1 ? routes[0]! : routes.length > 1 ? '__choose' : '';
    const usable = target !== '__choose' && !classification.showRemoved && !material?.library.sourceUnverified;
    return <div className="console-cue-cell" draggable={usable} onDragStart={event => { if (!usable) { event.preventDefault(); return; } event.dataTransfer.setData(CONSOLE_CUE_DRAG, JSON.stringify({ sequence: owner.sequence, cue, name, executor: target })); event.dataTransfer.effectAllowed = 'copy'; }}>
      {button}{composing ? <button disabled={!usable} title="加入当前 Cue" aria-label={`添加 ${name} 到当前 Cue`} onClick={() => onUse(owner.sequence, cue, name, target)}><Plus /></button> : null}
    </div>;
  };
  const controls = sequence ? <div className="ma2-pool-navigation"><strong title={`${sequence.sequence} · ${sequence.name ?? '未命名'}`}>{sequence.name ?? `序列 ${sequence.sequence}`}</strong>
        <select aria-label="序列预览播放目标" disabled={busy} value={executor} onChange={event => setRoute(event.target.value)}>{executors.length > 1 ? <option value="__choose" disabled>选择执行器</option> : null}{executors.map(value => <option key={value} value={value}>执行器 {value}</option>)}<option value="">序列池</option></select>
      </div> : null;
  return <section className="ma2-sequence-preview" aria-label="MA2 序列预览">
    <header className="ma2-material-menubar"><LightingAuditionStop/><div role="group" aria-label="素材分类">{([['all','全部'],['single','单步'],['multi','多步']] as const).map(([value,title])=><button key={value} aria-pressed={category===value && selected===null} onClick={()=>{setCategory(value);setSelected(null);setSingleSequence(null);setSelectedCue(null);setRoute(null);}}>{title}</button>)}</div>{controls}<button aria-pressed={classification.onlyUnclassified} onClick={()=>classification.setOnlyUnclassified(!classification.onlyUnclassified)}>未分类</button>{classification.hidden.size?<button aria-pressed={classification.showRemoved} onClick={()=>{classification.setShowRemoved(!classification.showRemoved);classification.setPicked([]);}}>已移除</button>:null}<label className="ma2-pool-search"><Search size={15} /><input aria-label="搜索序列或 Cue" placeholder="搜索名称 / 编号" value={query} onChange={event=>setQuery(event.target.value)} /></label></header>
    {classification.picked.length>1?<div className="ma2-classification-selection"><span>已选 {classification.picked.length} 项</span><button onClick={()=>classification.setPicked(singleRefs)}>全选结果</button><button onClick={()=>classification.setPicked([])}>取消选择</button></div>:null}
    {sequence ? <>
      {selected !== null ? <CuePoolGrid key={`sequence-${sequence.sequence}`} keys={visibleCues.map(value => value.number)} label="序列中的单步灯光" render={index => { const value = visibleCues[index]!; return materialCell(<button disabled={busy} title={`${value.number} · ${value.name ?? '未命名'} · 点击试听`} aria-pressed={selectedCue === value.number} aria-label={`试听灯光步 ${value.number}`} onContextMenu={event=>classification.open(event,{sequence:sequence.sequence,cue:value.number,kind:'single'},value.name??'')} onClick={event => { classification.select({sequence:sequence.sequence,cue:value.number,kind:'single'},event,visibleCues.map(cue=>({sequence:sequence.sequence,cue:cue.number,kind:'single'})));setSelectedCue(value.number); if(!classification.showRemoved)void send('goto', value.number); }}><LightingCategoryColors sections={classification.sections.get(consoleCueKey({sequence:sequence.sequence,cue:value.number,kind:'single'}))??[]}/><strong>{value.name ?? '未命名'}</strong></button>, sequence, value.number, value.name ?? `Cue ${value.number}`); }} /> : null}
    </> : null}
    {selected === null ? <>
      {category === 'single' ? <CuePoolGrid keys={singles.map(({sequence,cue})=>`${sequence.sequence}/${cue.number}`)} label="素材序列" render={index=>{const {sequence:owner,cue:step}=singles[index]!;return materialCell(<button data-classified={classification.classified.has(consoleCueKey({sequence:owner.sequence,cue:step.number,kind:'single'}))} data-picked={classification.picked.some(ref=>ref.sequence===owner.sequence&&ref.cue===step.number&&ref.kind==='single')} disabled={busy} aria-label={`试听序列 ${owner.sequence} 灯光步 ${step.number}`} aria-pressed={singleSequence===owner.sequence&&selectedCue===step.number} title={`${owner.name ?? owner.sequence} · ${step.number} · ${step.name ?? '未命名'}`} onContextMenu={event=>classification.open(event,{sequence:owner.sequence,cue:step.number,kind:'single'},step.name??'')} onClick={event=>{classification.select({sequence:owner.sequence,cue:step.number,kind:'single'},event,singleRefs);setSingleSequence(owner.sequence);setSelectedCue(step.number);if(singleSequence!==owner.sequence)setRoute(null);if(!classification.showRemoved)void send('goto',step.number,owner);}}><LightingCategoryColors sections={classification.sections.get(consoleCueKey({sequence:owner.sequence,cue:step.number,kind:'single'}))??[]}/><strong>{step.name ?? `Cue ${step.number}`}</strong></button>,owner,step.number,step.name ?? `Cue ${step.number}`);}} /> :
      <CuePoolGrid keys={visibleSequences.map(value => String(value.sequence))} label="素材序列" render={index => { const value = visibleSequences[index]!; return <button disabled={busy} aria-label={`${value.sequence} · ${value.name ?? '未命名'}`} title={`${value.sequence} · ${value.name ?? '未命名'} · ${value.cues.length} 步`} onContextMenu={event=>{const first=value.cues[0];if(first)classification.open(event,{sequence:value.sequence,cue:first.number,kind:value.cues.length===1?'single':'sequence'},value.name??'');}} onClick={() => { setSelected(value.sequence); setSelectedCue(null); setRoute(null); setQuery(''); if (value.complete && value.cues.length === 1) { setSelectedCue(value.cues[0]!.number); void send('goto', value.cues[0]!.number, value); } }}><strong>{value.name ?? `序列 ${value.sequence}`}</strong></button>; }} />}
      {!(category==='single' ? singles.length : visibleSequences.length) ? <span className="ma2-pool-empty">{library.length ? '无匹配素材' : '尚未读取素材'}</span> : null}
    </> : null}
    {classification.menu}
    <div className="ma2-pool-status" role={error ? 'alert' : 'status'} title={error || status}><span>{error || classification.message || (preview.command === 'sending' ? '发送中' : preview.command === 'sent' ? '指令已发送' : '')}</span><span title="高亮表示选中；控台活动 Cue 回读尚未验证"><AlertCircle size={13} />未回读播放状态</span></div>
  </section>;
}
