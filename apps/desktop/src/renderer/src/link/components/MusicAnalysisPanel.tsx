import { useEffect, useRef, useState } from 'react';
import { Flag, Square } from 'lucide-react';
import { createLightingMusic, type LightingDocument, type MusicAnalysisResult } from '@tb/schema';
import type { AudioEditor } from './useAudioEditor';
import { useDocumentStore } from '../stores/document-store';
import { CuePoolGrid } from './CuePoolGrid';

export function MusicAnalysisPanel({ editor, document, onChange, onBpm, onSeek }: { editor: AudioEditor | undefined; document: LightingDocument; onChange: (document: LightingDocument, label: string) => void; onBpm: (bpm: number) => void; onSeek: (ms: number) => void }): JSX.Element {
  const [result, setResult] = useState<MusicAnalysisResult | null>(null); const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState('beat'); const [progress, setProgress] = useState(''); const [error, setError] = useState('');
  const active = useRef<string | null>(null); const [busy, setBusy] = useState(false); const mounted = useRef(true);
  const audio = editor?.audio;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; const taskId = active.current; active.current = null; if (taskId) void window.tbLink.cancelMusicAnalysis({ version: 1, taskId }).catch(cause => console.error('取消音乐分析失败', cause)); }; }, []);
  useEffect(() => { setResult(null); setSelected(new Set()); const taskId = active.current; if (taskId) void window.tbLink.cancelMusicAnalysis({ version: 1, taskId }).catch(cause => setError(String(cause))); }, [audio]);
  const analyze = async (): Promise<void> => {
    if (!audio || active.current) return;
    const state = useDocumentStore.getState(); if (!state.path) { setError('请先保存工程'); return; }
    const taskId = crypto.randomUUID(); active.current = taskId; setBusy(true); setError('');
    try {
      const response = await window.tbLink.analyzeMusic({ version: 1, taskId, projectPath: state.path, source: audio }, update => { if (mounted.current && active.current === taskId) setProgress(`${update.message} ${Math.round(update.progress * 100)}%`); });
      if (!mounted.current || active.current !== taskId) return;
      const now = useDocumentStore.getState();
      if (now.documentId !== state.documentId || !now.project?.rundown.some(item => item.referenceAudio === audio)) throw new Error('歌曲或音源已改变，分析结果未应用');
      setResult(response); setSelected(new Set());
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (active.current === taskId) active.current = null; if (mounted.current) setBusy(false); }
  };
  const candidates = result?.candidates.filter(value => value.kind === kind) ?? [];
  const names = { beat: '节拍', hit: '疑似重击', roll: '疑似密集鼓点', silence: '疑似停顿' };
  const apply = (): void => {
    if (!result || result.sourceSha256 !== audio?.sha256 || result.durationMs !== audio.durationMs) { setError('分析依据已经失效，请重新分析'); return; }
    const values = result.candidates.filter(value => selected.has(value.id)); if (!values.length) return;
    onChange({ ...document, version: 2, music: document.music ?? createLightingMusic(), markers: [...document.markers, ...values.map(value => ({ id: crypto.randomUUID(), name: names[value.kind], kind: value.kind === 'beat' ? 'custom' as const : value.kind === 'silence' ? 'stop' as const : value.kind, startMs: value.startMs, endMs: value.endMs, color: '#eabb68', notes: '辅助检测候选，经用户确认' }))] }, '应用选中的音乐分析结果');
    setResult({ ...result, candidates: result.candidates.filter(value => !selected.has(value.id)) }); setSelected(new Set());
  };
  return <div className="music-analysis-results"><div className="music-inline-actions"><button disabled={!audio || editor?.disabled || busy} onClick={() => void analyze()}>分析音乐</button>{busy ? <button onClick={() => { const taskId = active.current; if (taskId) void window.tbLink.cancelMusicAnalysis({ version: 1, taskId }).catch(cause => setError(String(cause))); }}><Square />取消分析</button> : null}<select aria-label="辅助找点类型" value={kind} onChange={event => setKind(event.target.value)}>{Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select><span role="status">{busy ? progress : `${candidates.length} 个候选`}</span>{result?.bpm ? <button onClick={() => onBpm(result.bpm!)}>应用建议 {result.bpm} BPM</button> : null}<button disabled={!candidates.length} onClick={() => setSelected(new Set(candidates.map(value => value.id)))}>选择当前类型</button><button disabled={!selected.size} onClick={apply}><Flag />应用选中结果</button><button onClick={() => { setResult(null); setSelected(new Set()); }}>清除待确认结果</button></div>{error ? <p role="alert">{error}</p> : null}<CuePoolGrid cellWidth={260} keys={candidates.map(value => value.id)} label="待确认音乐分析结果" render={index => { const value = candidates[index]!; return <div className="classification-cell"><input type="checkbox" aria-label={`选择 ${names[value.kind]} ${value.startMs}`} checked={selected.has(value.id)} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(value.id); else next.delete(value.id); return next; })} /><button title="定位到候选位置" onClick={() => onSeek(value.startMs)}>{names[value.kind]} · {(value.startMs / 1000).toFixed(2)}{value.endMs !== null ? `–${(value.endMs / 1000).toFixed(2)}` : ''}s</button></div>; }} /></div>;
}
