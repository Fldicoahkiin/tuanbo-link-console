import { useEffect, useState } from 'react';
import { Play, SkipForward, Square, Search } from 'lucide-react';
import type { LightingDocument, Ma2PlaybackAction } from '@tb/schema';
import { LightingCueAudition } from '../../registry/lighting-cue-audition';
import '../ma2-sequence-preview.css';

type Sequence = { sequence: number; name: string | null; cues: { number: string; name: string | null }[]; complete: boolean };
export function Ma2SequencePreview({ document, onUse, onClose }: { document: LightingDocument; onUse: (sequence: number, cue: string, name: string, executor: string) => void; onClose: () => void }): JSX.Element {
  const [output] = useState(() => new LightingCueAudition());
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<'all' | 'single' | 'multi' | 'unknown'>('all');
  const [route, setRoute] = useState<string | null>(null);
  const [selectedCue, setSelectedCue] = useState<string | null>(null);
  const [status, setStatus] = useState('选择序列，点击灯光步试听；继续播放沿用控台编排');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => () => output.cancel(), [output]);
  const catalog = new Map<number, Sequence>();
  for (const sequence of [...document.ma2Library?.sequences ?? [], ...document.ma2Bindings?.flatMap(binding => binding.cueCatalog ?? []) ?? []]) {
    catalog.set(sequence.sequence, { ...sequence, complete: true, cues: [...sequence.cues].sort((a, b) => a.index - b.index) });
  }
  for (const template of document.templates) {
    const stamp = template.track.cueStamp;
    if (stamp?.mode !== 'fixed' || catalog.get(stamp.sequence)?.complete) continue;
    const entry = catalog.get(stamp.sequence) ?? { sequence: stamp.sequence, name: null, complete: false, cues: [] };
    if (!entry.cues.some(cue => Number(cue.number) === Number(stamp.cue))) entry.cues.push({ number: stamp.cue, name: template.name });
    entry.cues.sort((a, b) => Number(a.number) - Number(b.number)); catalog.set(stamp.sequence, entry);
  }
  const sequences = [...catalog.values()].sort((a, b) => a.sequence - b.sequence).filter(value => `${value.sequence} ${value.name ?? ''} ${value.cues.map(cue => cue.name).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const visibleSequences = sequences.filter(value => category === 'all' || (category === 'unknown' ? !value.complete : value.complete && (category === 'single' ? value.cues.length === 1 : value.cues.length > 1)));
  const sequence = catalog.get(selected ?? -1);
  const executors = sequence ? [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === sequence.sequence).map(mapping => mapping.executor)) ?? [])] : [];
  const executor = route ?? (executors.length === 1 ? executors[0]! : '');
  const cue = sequence?.cues.find(value => value.number === selectedCue) ?? sequence?.cues[0];
  const send = async (action: Ma2PlaybackAction['action'], number?: string, chosen = sequence): Promise<void> => {
    if (!chosen || busy) return;
    const routes = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === chosen.sequence).map(mapping => mapping.executor)) ?? [])];
    const destination = chosen.sequence === sequence?.sequence ? executor : routes.length === 1 ? routes[0]! : '';
    const target = destination ? `执行器 ${destination}` : `序列 ${chosen.sequence}`;
    const operation = action === 'goto' ? `调用灯光步 ${number}` : action === 'go' ? '继续播放' : '关闭输出';
    setBusy(true); setError(''); setStatus(`正在发送${operation} · ${target}`);
    try {
      const sent = await output.playAction(destination ? { target: 'executor', executor: destination, action, ...(number ? { cue: number } : {}) } : { target: 'sequence', sequence: chosen.sequence, action, ...(number ? { cue: number } : {}) });
      if (sent) setStatus(`已发送${operation} · ${target}；当前播放步未回读`);
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); setStatus('发送未完成'); }
    finally { setBusy(false); }
  };
  const cueIndex = sequence?.cues.findIndex(value => value.number === cue?.number) ?? -1;
  return <section className="ma2-sequence-preview" aria-label="MA2 序列预览">
    <header><div><h3>灯光素材库</h3><p>控台序列池 · 原始名称与灯光步骤</p></div><button onClick={onClose}>返回灯光编排</button></header>
    <div className={`ma2-sequence-body ${sequence ? "" : "pool-overview"}`}><aside><div className="ma2-pool-title"><strong>序列池</strong><small>{sequences.length} 个序列</small></div><label><Search size={16} /><input aria-label="搜索序列" placeholder="搜索编号或原始名称" value={query} onChange={event => setQuery(event.target.value)} /></label><div className="ma2-pool-categories" role="group" aria-label="素材分类">{([["all", "全部"], ["single", "单步灯光"], ["multi", "多步序列"], ["unknown", "目录待补全"]] as const).map(([value, title]) => <button key={value} aria-pressed={category === value} onClick={() => { setCategory(value); setSelected(null); }}>{title}</button>)}</div><nav aria-label="素材序列">{visibleSequences.map(value => <button disabled={busy} aria-pressed={sequence?.sequence === value.sequence} key={value.sequence} onClick={() => { setSelected(value.sequence); setSelectedCue(null); setRoute(null); if (value.complete && value.cues.length === 1) void send('goto', value.cues[0]!.number, value); }}><span className="ma2-pool-number">{value.sequence}</span><strong>{value.name ?? `序列 ${value.sequence}`}</strong><small>{value.complete ? value.cues.length === 1 ? "单步 · 点击出灯" : `多步 · ${value.cues.length} 步 · 进入` : `已缓存 ${value.cues.length} 步`}{value.complete ? '' : ' · 目录不完整'}</small></button>)}</nav><small>单步点击出灯；多步进入子菜单，逐步试听或完整播放。</small></aside>
    {sequence ? <article><div className="ma2-submenu-heading"><button onClick={() => setSelected(null)}>返回素材分类</button><strong>{sequence.cues.length > 1 ? "多步序列子菜单" : "单步灯光"}</strong></div>
      <section className="ma2-mini-executor" aria-label="执行器预览">
        <div className="ma2-sequence-heading"><div><small>序列 {sequence.sequence}</small><h3>{sequence.name ?? `序列 ${sequence.sequence}`}</h3></div><label>播放目标<select aria-label="序列预览播放目标" disabled={busy} value={executor} onChange={event => setRoute(event.target.value)}>{executors.map(value => <option key={value} value={value}>执行器 {value} · 原执行器</option>)}<option value="">序列池 · 直接播放</option></select></label></div>
        <div className="ma2-mini-steps" aria-label="灯光步骤浏览">{[-1, 0, 1].map(delta => { const step = sequence.cues[cueIndex + delta]; return <button key={delta} className={delta === 0 ? 'selected-step' : ''} disabled={!step || busy} onClick={() => { if (step) { setSelectedCue(step.number); void send('goto', step.number); } }}><small>{delta < 0 ? '上一编号' : delta === 0 ? '选中灯光步 · 点击试听' : '下一编号'}</small><b>{step?.number ?? '—'}</b><span>{step?.name ?? (step ? '未命名' : '无')}</span><Play size={14} /></button>; })}</div>
        <div className="ma2-sequence-controls"><button className="primary-button" disabled={busy || !sequence.cues.length} onClick={() => { const first = sequence.cues[0]; if (first) { setSelectedCue(first.number); void send('goto', first.number); } }}><Play />从第一步开始</button><button disabled={busy} onClick={() => void send('go')}><SkipForward />继续</button><button disabled={busy} onClick={() => void send('off')}><Square />关闭输出</button></div>
        <div className="ma2-playback-state"><span>控台当前播放步</span><strong>未回读</strong><small>亮度与渐变由控台控制</small></div>
      </section>
      <div className="ma2-sheet-title"><strong>单步灯光</strong><small>{sequence.cues.length} 步</small><button disabled={!cue || busy} onClick={() => { if (cue) onUse(sequence.sequence, cue.number, cue.name ?? `灯光步 ${cue.number}`, executor); }}>选中步骤加入编排</button></div>
      <div className="ma2-cue-submenu" aria-label="序列中的单步灯光">{sequence.cues.map(value => <button key={value.number} disabled={busy} aria-pressed={cue?.number === value.number} aria-label={`试听灯光步 ${value.number}`} onClick={() => { setSelectedCue(value.number); void send('goto', value.number); }}><span className="ma2-pool-number">{value.number}</span><strong>{value.name ?? '未命名'}</strong><small><Play size={14} />点击出灯</small></button>)}</div>      <p role="status">{status}</p>{error ? <p role="alert">{error}</p> : null}
      <footer>自动跟随、定时触发与循环沿用控台设置。{executor ? '通过原执行器播放。' : '通过序列池播放。'}列表高亮表示选中步骤；切换列表不会关闭已运行的灯光。</footer>
    </article> : null}</div>
  </section>;
}

