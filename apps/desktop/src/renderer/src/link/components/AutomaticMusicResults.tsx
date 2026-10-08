import { useMemo, useState } from 'react';
import { Check, MapPin, Trash2 } from 'lucide-react';
import type { AutomaticMusicCandidates, LightingDocument, ReferenceAudio } from '@tb/schema';
import { applyAutomaticMusicCandidates, removeAutomaticMusicAnnotations } from '@tb/core/link';
import { CuePoolGrid } from './CuePoolGrid';

export function AutomaticMusicResults({ candidates, document, source, disabled, onChange, onSeek, onClear }: {
  candidates: AutomaticMusicCandidates; document: LightingDocument; source: ReferenceAudio; disabled: boolean;
  onChange: (value: LightingDocument, label: string) => void; onSeek: (ms: number) => void; onClear: () => void;
}): JSX.Element {
  const [kind, setKind] = useState<'beat' | 'downbeat' | 'section'>('section');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const items = useMemo(() => candidates.items.filter(item => item.kind === kind), [candidates, kind]);
  const applied = useMemo(() => new Set([...document.markers, ...document.music?.sections ?? []].map(item => item.id)), [document]);
  const isApplied = (id: string): boolean => applied.has(`analysis:${source.sha256}:${id}`);
  const pendingSelected = [...selected].filter(id => !isApplied(id));
  const remove = (ids: string[]): void => {
    if (disabled) return;
    try {
      const result: unknown = onChange(removeAutomaticMusicAnnotations(document, source.sha256, new Set(ids.map(id => `analysis:${source.sha256}:${id}`))), '删除分析标记');
      if (result === false) throw new Error('删除失败，请处理工程提示后重试');
      setSelected(current => new Set([...current].filter(id => !ids.includes(id)))); setMessage('已删除，可撤销');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const apply = (): void => {
    try {
      const next = applyAutomaticMusicCandidates(document, source, candidates, new Set(pendingSelected));
      onChange(next, '应用音乐分析结果'); setMessage('已提交选中结果，可撤销'); setSelected(new Set());
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="automatic-music-results">
    <div className="analysis-result-heading"><strong>分析结果</strong><span>{candidates.bpm ? `建议 ${candidates.bpm} BPM` : '未检测到稳定速度'}</span></div>
    <div className="analysis-result-tabs" role="group" aria-label="分析结果类型">{([['section', '段落'], ['downbeat', '小节第一拍'], ['beat', '节拍']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)}>{label} <span>{candidates.items.filter(item => item.kind === value).length}</span></button>)}</div>
    <div className="analysis-result-selection"><button type="button" onClick={() => setSelected(current => new Set([...current, ...items.filter(item => !isApplied(item.id)).map(item => item.id)]))}>选择当前类</button><button type="button" disabled={!selected.size} onClick={() => setSelected(new Set())}>取消选择</button><button type="button" disabled={disabled || !items.some(item => isApplied(item.id))} onClick={() => remove(items.filter(item => isApplied(item.id)).map(item => item.id))}>删除本类标记</button><span>已选 {pendingSelected.length}</span></div>
    {!items.length ? <p>没有此类结果</p> : <CuePoolGrid keys={items.map(item => item.id)} label="音乐分析候选" cellWidth={1000} rowHeight={36} render={index => {
      const item = items[index]!; const done = isApplied(item.id);
      return <div className="analysis-result-row"><input type="checkbox" aria-label={`选择 ${item.name}`} title={done ? '取消勾选会删除已应用标记，可撤销' : '选择待应用结果'} disabled={disabled} checked={done || selected.has(item.id)} onChange={event => { if (done) { remove([item.id]); return; } setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} /><button type="button" disabled={disabled} title="定位到此结果" onClick={() => onSeek(item.startMs)}><MapPin size={13} /><span>{item.name}</span><code>{(item.startMs / 1000).toFixed(2)}{item.endMs !== null ? `–${(item.endMs / 1000).toFixed(2)}` : ''}s</code></button>{done ? <><Check size={14} aria-label="已应用" /><button className="analysis-delete-marker" type="button" disabled={disabled} aria-label={`删除 ${item.name}`} onClick={() => remove([item.id])}><Trash2 size={14} /></button></> : null}</div>;
    }} />}
    {message ? <p role="status">{message}</p> : null}
    <div className="analysis-result-footer"><button type="button" title="清除候选预览，已应用的标记保留" onClick={onClear}><Trash2 size={14} />清除预览</button><button type="button" className="primary" disabled={disabled || !pendingSelected.length} onClick={apply}>应用选中 {pendingSelected.length || ''}</button></div>
    <p className="timeline-analysis-footnote">点击结果定位；模型建议可修改，应用不会移动或触发灯光 Cue。</p>
  </div>;
}

export function AutomaticMusicPreview({ candidates, left, width, pixelsPerSecond, onSeek, sectionsOnly = false }: {
  candidates: AutomaticMusicCandidates; left: number; width: number; pixelsPerSecond: number; onSeek: (ms: number) => void; sectionsOnly?: boolean;
}): JSX.Element {
  const visible = candidates.items.filter(item => (item.kind === 'section') === sectionsOnly && (item.endMs ?? item.startMs) / 1000 * pixelsPerSecond >= left && item.startMs / 1000 * pixelsPerSecond <= left + width);
  return <div className="analysis-timeline-preview" aria-label={sectionsOnly ? '候选段落预览' : '音乐分析候选预览'}>{visible.map(item => item.kind === 'section'
    ? <button type="button" key={item.id} className="analysis-section-candidate" title={`${item.name} · 待确认`} style={{ left: item.startMs / 1000 * pixelsPerSecond, width: (item.endMs! - item.startMs) / 1000 * pixelsPerSecond }} onClick={event => { event.stopPropagation(); onSeek(item.startMs); }}>{item.name}</button>
    : <span key={item.id} className="analysis-beat-candidate" data-kind={item.kind} style={{ left: item.startMs / 1000 * pixelsPerSecond }} />)}</div>;
}
