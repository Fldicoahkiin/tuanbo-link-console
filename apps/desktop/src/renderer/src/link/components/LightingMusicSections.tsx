import { useState } from 'react';
import { lightingDocumentSchema, type AutomaticMusicCandidates, type LightingDocument } from '@tb/schema';
import type { LightingTimelineDisplay } from './LightingTimelineControls';
import { AutomaticMusicPreview } from './AutomaticMusicResults';
import { ModalSurface } from '../ui/ModalSurface';

export function LightingMusicSections({ display, document, pixelsPerSecond, left, width, onSeek, onChange }: { display: LightingTimelineDisplay; document: LightingDocument; pixelsPerSecond: number; left: number; width: number; onSeek: (ms: number) => void; onChange: (next: LightingDocument, label: string) => void }): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const selected = document.music?.sections.find(section => section.id === editing);
  const change = (next: LightingDocument, label: string): void => {
    try { onChange(lightingDocumentSchema.parse(next), label); setEditing(null); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <>{display.sections && document.music?.sections.filter(section => !section.id.startsWith('analysis:')).filter(section => section.endMs / 1000 * pixelsPerSecond >= left && section.startMs / 1000 * pixelsPerSecond <= left + width).map(section => <button key={section.id} className="music-section-strip" title={`${section.name} · 双击编辑`} style={{ left: section.startMs / 1000 * pixelsPerSecond, width: (section.endMs - section.startMs) / 1000 * pixelsPerSecond, borderColor: section.color, background: `${section.color}33` }} onClick={event => { event.stopPropagation(); onSeek(section.startMs); }} onDoubleClick={() => { setEditing(section.id); setError(''); }} onKeyDown={event => { if (event.key === 'F2') { event.preventDefault(); setEditing(section.id); setError(''); } }}>{section.name}</button>)}
    {selected && document.music ? <ModalSurface label="编辑歌曲段落" className="music-section-dialog" onClose={() => setEditing(null)}><form onSubmit={event => {
      event.preventDefault(); const fields = new FormData(event.currentTarget);
      const name = fields.get('name');
      if (typeof name !== 'string' || !name.trim()) { setError('请填写段落名称'); return; }
      const next = { ...selected, name: name.trim(), startMs: Number(fields.get('start')) * 1000, endMs: Number(fields.get('end')) * 1000 };
      if (next.endMs <= next.startMs || document.music!.sections.some(section => section.id !== selected.id && next.startMs < section.endMs && next.endMs > section.startMs)) { setError('结束时间要晚于开始时间，并且不能和其他段落重叠'); return; }
      change({ ...document, music: { ...document.music!, sections: document.music!.sections.map(section => section.id === selected.id ? next : section) } }, '编辑歌曲段落');
    }}><strong>编辑段落</strong><label>名称<input name="name" required defaultValue={selected.name} /></label><div className="music-section-times"><label>开始（秒）<input name="start" type="number" min="0" step="0.001" required defaultValue={selected.startMs / 1000} /></label><label>结束（秒）<input name="end" type="number" min="0" step="0.001" required defaultValue={selected.endMs / 1000} /></label></div>{error ? <p role="alert">{error}</p> : null}<footer><button type="button" onClick={() => change({ ...document, music: { ...document.music!, sections: document.music!.sections.filter(section => section.id !== selected.id) } }, '删除歌曲段落')}>删除段落</button><button type="button" onClick={() => setEditing(null)}>取消</button><button type="submit">保存</button></footer></form></ModalSurface> : null}
  </>;
}

export function LightingMusicSectionRow({ candidates, document, pixelsPerSecond, left, width, onSeek, onChange }: { candidates: AutomaticMusicCandidates | undefined; document: LightingDocument; pixelsPerSecond: number; left: number; width: number; onSeek: (ms: number) => void; onChange: (next: LightingDocument, label: string) => void }): JSX.Element {
  const applied = new Set(document.music?.sections.map(section => section.id));
  const pending = candidates ? { ...candidates, items: candidates.items.filter(item => !applied.has(`analysis:${candidates.sourceSha256}:${item.id}`)) } : undefined;
  return <div className="music-section-row" onPointerDown={event => event.stopPropagation()}>
    {pending ? <AutomaticMusicPreview sectionsOnly candidates={pending} left={left} width={width} pixelsPerSecond={pixelsPerSecond} onSeek={onSeek} /> : null}
    <LightingMusicSections display={{ sections: true, markers: true, rawAnalysis: false }} document={document} pixelsPerSecond={pixelsPerSecond} left={left} width={width} onSeek={onSeek} onChange={onChange} />
  </div>;
}
