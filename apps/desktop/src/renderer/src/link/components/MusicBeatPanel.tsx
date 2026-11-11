import { RefreshCw, X, Trash2, Square } from 'lucide-react';
import type { LightingDocument, ReferenceAudioSource } from '@tb/schema';
import type { useAutomaticMusicAnalysis } from '../runtime/use-automatic-music-analysis';
import type { MusicBeatSegments } from './useMusicBeatSegments';
import { useDocumentStore } from '../stores/document-store';
import { musicSegmentAt, musicSegmentTempoLabel } from '../view-models/music-segment-display';
import { musicAnalysisHeading } from '../view-models/music-analysis-display';
import { Button, Disclosure, Field, IconButton, Select, TextInput, WithUnit } from '../ui';
import './music-analysis.css';
import { usePlayheadValue, type EditorPlayhead } from './editor-playhead';

export type MusicBeatPanelProps = {
  beats: MusicBeatSegments; analysis: ReturnType<typeof useAutomaticMusicAnalysis>;
  document: LightingDocument; playhead: EditorPlayhead; source: ReferenceAudioSource | undefined; projectPath: string | null; playing: boolean;
  onChange: (value: LightingDocument, label: string) => void; onSeek: (ms: number) => void; onClose: () => void;
};
const seconds = (ms: number): string => (ms / 1000).toFixed(2);
export function MusicBeatPanel({ beats, analysis, source, projectPath, playhead, onSeek, onClose }: MusicBeatPanelProps): JSX.Element {
  const data = beats.data;
  // The section at the playhead: drawn again only when the playhead enters another one (0.5.9 E2).
  const current = usePlayheadValue(playhead, positionMs => musicSegmentAt(beats.points, positionMs));
  const dirty = useDocumentStore(state => state.dirty);
  const devices = analysis.status?.devices ?? [];
  const message = !source ? '先添加音乐' : !projectPath ? '先保存工程，保存后会自动分析' : beats.error || analysis.error || (beats.busy || analysis.job?.state === 'failed' || analysis.job?.state === 'cancelled' ? analysis.job?.message : !analysis.status?.available ? analysis.status?.reason : beats.stale && !beats.busy ? beats.stale : beats.blocked ? '识别在后台继续，停止播放后会写入分段结果。' : current?.bpm === null ? '这一段拍点太少，算不出 BPM，可以检查拍点或重新分析。' : null);
  return <section className="music-analysis-panel" aria-label="音乐节拍分段">
    <header><strong className="music-bpm" title={current?.name}>{musicAnalysisHeading(data, current, analysis.job, analysis.submitting, analysis.error)}</strong><strong>音乐分段</strong><span>{data?.beatsPerBar ? `每小节 ${data.beatsPerBar} 拍` : '小节拍数未确定'}</span><IconButton label="关闭节拍分段" icon={X} onClick={onClose} /></header>
    <div className="music-beat-actions">
      {beats.busy ? <Button variant="secondary" size="sm" icon={Square} disabled={analysis.submitting || analysis.job?.state === 'cancelling'} onClick={beats.cancel}>取消分析</Button> : <Button variant="primary" size="sm" icon={RefreshCw} disabled={beats.blocked || !source || !projectPath || !analysis.status?.available} onClick={beats.start}>{data || analysis.job ? '重新分析' : '分析音乐'}</Button>}
      <Button variant="secondary" size="sm" icon={Trash2} disabled={beats.blocked || beats.busy || data?.state !== 'ready'} onClick={beats.clear}>清除标记</Button>
      <span>{data?.state === 'cleared' ? '标记已清除' : data ? `${beats.points.length} 段 · ${dirty ? '待保存' : '已保存到工程'}` : ''}</span>
    </div>
    {message ? <p className="music-analysis-message" role="status">{message}</p> : null}
    {beats.points.length ? <div className="music-beat-overview music-recognized-sections" aria-label="自动音乐分段">{beats.points.map(point => <button key={point.id} type="button" aria-pressed={beats.selected?.id === point.id} onClick={() => { beats.select(point.id); onSeek(point.startMs); }}><i /><span>{point.name}</span><strong>{musicSegmentTempoLabel(point)}</strong><time>{seconds(point.startMs)}–{seconds(point.endMs)}s</time></button>)}</div> : <p className="music-beat-hint">{data?.state === 'ready' ? '未识别到稳定节拍或音乐段落' : beats.busy ? '正在识别段落边界与各段速度…' : '分析完成后，节拍和段落直接显示在时间线上。'}</p>}
    {beats.selected ? <form key={`${beats.selected.id}:${beats.selected.name}:${beats.selected.startMs}:${beats.selected.endMs}`} className="music-segment-editor" onSubmit={event => { event.preventDefault(); if (!beats.selected) return; const fields = new FormData(event.currentTarget); beats.update({ ...beats.selected, name: event.currentTarget.querySelector<HTMLInputElement>('[name=name]')!.value.trim(), startMs: Number(fields.get('start')) * 1000, endMs: Number(fields.get('end')) * 1000 }); }}>
      <Field stacked label="名称">{field => <TextInput {...field} name="name" aria-label="段落名称" required maxLength={100} defaultValue={beats.selected?.name} />}</Field>
      <Field stacked label="开始">{field => <WithUnit unit="秒"><TextInput {...field} name="start" aria-label="段落开始" type="number" required min="0" step="0.001" defaultValue={(beats.selected?.startMs ?? 0) / 1000} /></WithUnit>}</Field>
      <Field stacked label="结束">{field => <WithUnit unit="秒"><TextInput {...field} name="end" aria-label="段落结束" type="number" required min="0" step="0.001" defaultValue={(beats.selected?.endMs ?? 0) / 1000} /></WithUnit>}</Field>
      <div className="music-segment-actions"><Button type="submit" variant="primary" size="sm" disabled={beats.blocked || beats.busy}>保存修改</Button><Button type="button" variant="danger" size="sm" icon={Trash2} disabled={beats.blocked || beats.busy} onClick={() => beats.selected && beats.remove(beats.selected.id)}>删除此段</Button></div>
    </form> : null}
    <Disclosure className="analysis-technical-details" title="分析信息">
      <p>按音乐的变化划分段落，不区分主歌、副歌。BPM 按这一段的拍点估算：变速段显示起止速度，拍点不规则时显示中位数估算，拍点太少时显示“无可测 BPM”。</p>
      {devices.length > 1 ? <Field stacked label="计算设备">{field => <Select {...field} width="auto" aria-label="音乐分析计算设备" value={analysis.device} disabled={beats.busy} onChange={event => { if (event.target.value === 'cpu' || event.target.value === 'cuda') analysis.setDevice(event.target.value); }}>{devices.map(device => <option key={device} value={device}>{device === 'cuda' ? 'GPU' : 'CPU'}</option>)}</Select>}</Field> : null}
      {analysis.job?.summary ? <p className="timeline-analysis-summary">{analysis.job.summary.elapsedSeconds.toFixed(1)} 秒{analysis.job.summary.cached ? ' · 缓存' : ''}</p> : null}
    </Disclosure>
  </section>;
}
