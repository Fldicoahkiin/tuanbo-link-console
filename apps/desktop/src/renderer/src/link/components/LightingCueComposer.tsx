import { useState } from 'react';
import { PropertyNumberInput } from './PropertyNumberInput';
import { Plus, X, Check, Save } from 'lucide-react';
import { LightingTempoMap, lightingEventTime, removeLightingEffects } from '@tb/core/link';
import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument, type LightingEvent } from '@tb/schema';
import { placeEffect } from './useLightingEffectStamp';
import { LightingCuePreparation } from './LightingCuePreparation';

export type CueIngredient = { name: string; sequence: number; cue: string; executor: string; delayMs: number; preparation?: Extract<LightingEvent, { kind: 'ma2' }>['preparation'] };
export function cueIngredients(document: LightingDocument, eventId?: string): CueIngredient[] {
  if (!eventId) return [];
  const events = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
  return events.flatMap(event => {
    if (event.kind !== 'ma2' || !(event.id === eventId || event.effectGroupId === eventId) || !event.sequence || !event.cue) return [];
    const source = document.templates.find(effect => { const binding = effect.track.cueStamp; return binding?.mode === 'fixed' && binding.sequence === event.sequence && binding.cue === event.cue && binding.executor === event.executor; });
    return [{ name: source?.name ?? (event.label || `Cue ${event.cue}`), sequence: event.sequence, cue: event.cue, executor: event.executor, delayMs: 0, ...(event.preparation ? { preparation: event.preparation } : {}) }];
  });
}
export function saveCueIngredients(document: LightingDocument, ingredients: CueIngredient[], name: string, ms: number, durationMs: number, eventId?: string): LightingDocument {
  if (!ingredients.length) throw new Error('请先选择素材');
  if (ingredients.some(entry => entry.executor && !/^[1-9]\d*\.[1-9]\d*$/.test(entry.executor))) throw new Error('执行器格式应为页号.编号；留空即可使用序列池');
  if (new Set(ingredients.map(entry => entry.executor ? `executor:${entry.executor}` : `sequence:${entry.sequence}`)).size !== ingredients.length) throw new Error('同一序列池序列或同一执行器只能使用一个 Cue，请先替换冲突素材');
  const first = document.templates.find(effect => effect.track.cueStamp?.mode === 'fixed');
  const map = new LightingTempoMap(document.tempos);
  for (const track of document.tracks) for (const clip of track.clips) {
    const event = clip.events.find(entry => entry.id === eventId);
    if (event) ms = lightingEventTime(clip, event, map);
  }
  if (durationMs <= 0 || ms < 0 || ms >= durationMs) throw new Error('请先添加音频，并将播放头放在音频范围内');
  if (ingredients.some(entry => entry.preparation && entry.preparation.leadMs > ms)) throw new Error('埋步不能早于节目开始，请缩短提前时间或后移正式 Cue');
  if (ingredients.some(entry => entry.preparation && (!/^\d{1,4}(?:\.\d{1,3})?$/.test(entry.preparation.cue) || Number(entry.preparation.cue) <= 0 || Number(entry.preparation.cue) === Number(entry.cue)))) throw new Error('请填写与正式 Cue 不同的有效准备 Cue 编号');
  const base = eventId ? removeLightingEffects(document, [eventId]) : document;
  const ingredient = ingredients[0]!;
  const track = first?.track ?? lightingTrackSchema.parse({ id: crypto.randomUUID(), name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] });
  const temporary = { ...first, id: crypto.randomUUID(), name: name.trim() || '灯光组合', track: { ...track, cueStamp: { mode: 'fixed' as const, sequence: ingredient.sequence, cue: ingredient.cue, executor: ingredient.executor } }, members: ingredients.length > 1 ? ingredients.map(({ name, sequence, cue, executor }) => ({ name, sequence, cue, executor, delayMs: 0 })) : undefined };
  const id = eventId ?? crypto.randomUUID();
  const placed = placeEffect({ ...base, templates: [...base.templates, temporary] }, { effectId: temporary.id, ms, id }, durationMs);
  const result = retainCueLocations(document, placed, id, ms, map);
  return lightingDocumentSchema.parse({ ...result, templates: document.templates, tracks: result.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.map(event => {
    if (event.kind !== 'ma2' || (event.id !== id && event.effectGroupId !== id)) return event;
    const source = ingredients.find(entry => entry.sequence === event.sequence && entry.executor === event.executor);
    return { ...event, ...(event.id === id ? { label: temporary.name } : {}), ...(source?.preparation ? { preparation: source.preparation } : {}) };
  }) })) })) });
}

/** Editing an imported Cue must retain its output route and MA2 event mapping. */
function retainCueLocations(before: LightingDocument, placed: LightingDocument, id: string, ms: number, map: LightingTempoMap): LightingDocument {
  const original = before.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => event.id === id || event.effectGroupId === id ? [{ track, clip, event }] : [])))
    .sort((a, b) => Number(b.event.id === id) - Number(a.event.id === id));
  if (!original.length) return placed;
  const generated = placed.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.id === id || event.effectGroupId === id)))
    .sort((a, b) => Number(b.id === id) - Number(a.id === id));
  const moved = new Map<string, { clipId: string; event: LightingEvent }>();
  generated.forEach((event, index) => {
    const slot = original[index]; if (!slot) return;
    const at = (slot.clip.timeLock === 'time' ? ms : map.msToBeat(ms)) - slot.clip.start;
    if (at < 0) throw new Error('组合的正式时间早于原片段起点，请先调整片段');
    moved.set(event.id, { clipId: slot.clip.id, event: { ...event, id: slot.event.id, at } });
  });
  const tracks = placed.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
    const restored = [...moved.values()].filter(value => value.clipId === clip.id).map(value => value.event);
    return { ...clip, duration: Math.max(clip.duration, ...restored.map(event => event.at + 1)), events: [...clip.events.filter(event => !moved.has(event.id)), ...restored] };
  }) })).filter(track => before.tracks.some(old => old.id === track.id) || track.clips.some(clip => clip.events.length));
  return { ...placed, tracks };
}

export function LightingCueComposer({ document, eventId, ms, durationMs, ingredients, onIngredients, onChange, onNew, disabled, details }: { details: boolean; document: LightingDocument; eventId?: string | undefined; ms: number; durationMs: number; ingredients: CueIngredient[]; onIngredients: (values: CueIngredient[]) => void; onChange: (document: LightingDocument, label: string) => boolean | void; onNew: () => void; disabled: boolean }): JSX.Element {
  const [name, setName] = useState(() => document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => event.kind === 'ma2' && event.id === eventId ? [event.label] : [])))[0] ?? '');
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<string>();
  const [savedSignature, setSavedSignature] = useState('');
  const usesExecutors = ingredients.some(entry => Boolean(entry.executor));
  const targetId = eventId ?? createdId;
  const tempoMap = new LightingTempoMap(document.tempos);
  const cueTime = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.id === targetId).map(event => lightingEventTime(clip, event, tempoMap))))[0] ?? ms;
  const signature = JSON.stringify({ ingredients, name, ms: cueTime });
  const saved = savedSignature === signature;
  const setSaved = (value: boolean): void => setSavedSignature(value ? signature : '');
  return <aside className="cue-composer" aria-label={details ? '点位素材组合' : 'Cue 组合编辑'}>
    <header><input aria-label="Cue 名称" placeholder="填写 Cue 名称" value={name} onChange={event => { setName(event.target.value); setSaved(false); }} /><button title="新建 Cue" aria-label="新建 Cue" onClick={onNew}><Plus /><span>新建</span></button></header>
    <small>时间线位置 · {(cueTime / 1000).toFixed(3)} 秒 · {ingredients.length} 个素材</small>
    <div className="cue-ingredients">{ingredients.length ? <table aria-label="Cue 内容"><thead><tr><th>素材</th><th>序列</th><th>Cue 编号</th>{usesExecutors ? <th title="保留已有执行器引用；清空可改为按序列池调用">执行器（可选）</th> : null}<th><span className="sr-only">移除</span></th></tr></thead><tbody>{ingredients.map((entry, index) => <tr key={`${entry.name}/${index}`}><td>{entry.name}</td><td><PropertyNumberInput label={`素材 ${index + 1} 序列`} min={1} max={99999} value={entry.sequence} disabled={disabled} onCommit={value => onIngredients(ingredients.map((item, i) => i === index ? { ...item, sequence: value } : item))} /></td><td><input aria-label={`素材 ${index + 1} Cue 编号`} value={entry.cue} disabled={disabled} onChange={event => onIngredients(ingredients.map((item, i) => i === index ? { ...item, cue: event.target.value } : item))} /></td>{usesExecutors ? <td><input placeholder="序列池" aria-label={`素材 ${index + 1} 执行器`} title="页号.推杆或按键编号，例如 1.101" value={entry.executor} disabled={disabled} onChange={event => onIngredients(ingredients.map((item, i) => i === index ? { ...item, executor: event.target.value } : item))} /></td> : null}<td><button disabled={disabled} aria-label={`移除素材 ${entry.name}`} onClick={() => { onIngredients(ingredients.filter((_, i) => i !== index)); setSaved(false); }}><X /></button></td></tr>)}</tbody></table> : <p>从左侧选择素材，组合这一刻的灯光。</p>}</div>
    {ingredients.length ? <LightingCuePreparation document={document} ingredients={ingredients} onChange={onIngredients} cueTime={cueTime} disabled={disabled} /> : null}
    {ingredients.some(entry => !entry.executor) && document.outputMode !== 'network' || ingredients.some(entry => entry.preparation) && document.outputMode === 'timecode' ? <small>当前 Cue 需要直控播放。请在左侧播放设置选择“网络 · 直接播放序列池”。</small> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button className="cue-save" aria-label={eventId || createdId ? '保存 Cue' : '添加 Cue'} disabled={disabled || !ingredients.length || saved || durationMs <= 0} onClick={() => { try { const id = eventId ?? createdId ?? crypto.randomUUID(); const result = onChange(saveCueIngredients(document, ingredients, name, ms, durationMs, id), '保存 Cue 组合'); if (result === false) { setError('保存失败，请处理提示后重试'); return; } setCreatedId(id); setError(''); setSaved(true); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>{saved ? <Check /> : <Save />}<span>{saved ? '已保存到时间线' : eventId || createdId ? '保存 Cue 修改' : '确认为一个 Cue'}</span></button>
    {durationMs <= 0 ? <small>请先为当前节目添加音频。</small> : null}
  </aside>;
}
