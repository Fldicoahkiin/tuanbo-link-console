import { useState } from 'react';
import { Plus, X, Check, Save } from 'lucide-react';
import { LightingTempoMap, lightingEventTime, removeLightingEffects } from '@tb/core/link';
import type { LightingDocument } from '@tb/schema';
import { placeEffect } from './useLightingEffectStamp';

export type CueIngredient = { name: string; sequence: number; cue: string; executor: string; delayMs: number };
export function cueIngredients(document: LightingDocument, eventId?: string): CueIngredient[] {
  if (!eventId) return [];
  const events = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
  return events.flatMap(event => {
    if (event.kind !== 'ma2' || !(event.id === eventId || event.effectGroupId === eventId) || !event.sequence || !event.cue || !event.executor) return [];
    const source = document.templates.find(effect => { const binding = effect.track.cueStamp; return binding?.mode === 'fixed' && binding.sequence === event.sequence && binding.cue === event.cue && binding.executor === event.executor; });
    return [{ name: source?.name ?? (event.label || `Cue ${event.cue}`), sequence: event.sequence, cue: event.cue, executor: event.executor, delayMs: 0 }];
  });
}
export function saveCueIngredients(document: LightingDocument, ingredients: CueIngredient[], name: string, ms: number, durationMs: number, eventId?: string): LightingDocument {
  if (!ingredients.length) throw new Error('请先选择素材');
  if (ingredients.some(entry => !/^[1-9]\d*\.[1-9]\d*$/.test(entry.executor))) throw new Error('请先为素材绑定真实执行器');
  if (new Set(ingredients.map(entry => entry.executor)).size !== ingredients.length) throw new Error('同一执行器只能使用一个素材，请先替换冲突素材');
  const first = document.templates.find(effect => effect.track.cueStamp?.mode === 'fixed');
  if (!first) throw new Error('请先添加素材');
  const map = new LightingTempoMap(document.tempos);
  for (const track of document.tracks) for (const clip of track.clips) {
    const event = clip.events.find(entry => entry.id === eventId);
    if (event) ms = lightingEventTime(clip, event, map);
  }
  const base = eventId ? removeLightingEffects(document, [eventId]) : document;
  const ingredient = ingredients[0]!;
  const temporary = { ...first, id: crypto.randomUUID(), name: name.trim() || '灯光组合', track: { ...first.track, cueStamp: { mode: 'fixed' as const, sequence: ingredient.sequence, cue: ingredient.cue, executor: ingredient.executor } }, members: ingredients.length > 1 ? ingredients : undefined };
  const id = eventId ?? crypto.randomUUID();
  const result = placeEffect({ ...base, templates: [...base.templates, temporary] }, { effectId: temporary.id, ms, id }, durationMs);
  return { ...result, templates: document.templates, tracks: result.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.map(event => event.id === id ? { ...event, label: temporary.name } : event) })) })) };
}

export function LightingCueComposer({ document, eventId, ms, durationMs, ingredients, onIngredients, onChange, onNew, disabled, details, onAddMaterials }: { details: boolean; onAddMaterials: () => void; document: LightingDocument; eventId?: string | undefined; ms: number; durationMs: number; ingredients: CueIngredient[]; onIngredients: (values: CueIngredient[]) => void; onChange: (document: LightingDocument, label: string) => void; onNew: () => void; disabled: boolean }): JSX.Element {
  const [name, setName] = useState(() => document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => event.kind === 'ma2' && event.id === eventId ? [event.label] : [])))[0] ?? '');
  const [error, setError] = useState('');
  const [savedSignature, setSavedSignature] = useState('');
  const signature = JSON.stringify({ ingredients, name, ms });
  const saved = savedSignature === signature;
  const setSaved = (value: boolean): void => setSavedSignature(value ? signature : '');
  return <aside className="cue-composer" aria-label={details ? '点位素材组合' : 'Cue 组合编辑'}><header>{!details ? <strong>{eventId ? '编辑 Cue' : '新 Cue'}</strong> : null}{details ? <button title="添加素材" aria-label="向点位添加素材" onClick={onAddMaterials}><Plus /><span>添加素材</span></button> : <button title="新建 Cue" aria-label="新建 Cue" onClick={onNew}><Plus /></button>}</header>
    <input aria-label="Cue 名称" placeholder="给这个组合起个名字" value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
    <small>{eventId ? '包含 ' + ingredients.length + ' 个素材' : `当前位置 · ${(ms / 1000).toFixed(3)} 秒`}</small>
    <div className="cue-ingredients">{ingredients.map((entry, index) => <div key={`${entry.executor}/${entry.cue}`}><span><strong>{entry.name}</strong><small>{entry.executor} · Cue {entry.cue}</small></span><button aria-label={`移除素材 ${entry.name}`} onClick={() => { onIngredients(ingredients.filter((_, i) => i !== index)); setSaved(false); }}><X /></button></div>)}{!ingredients.length ? <p>从左侧选择素材，组合这一刻的灯光。</p> : null}</div>
    {error ? <p role="alert">{error}</p> : null}
    <button className="cue-save" title={eventId ? '保存 Cue' : '添加 Cue'} aria-label={eventId ? '保存 Cue' : '添加 Cue'} disabled={disabled || !ingredients.length || saved} onClick={() => { try { onChange(saveCueIngredients(document, ingredients, name, ms, durationMs, eventId), '保存 Cue 组合'); setError(''); setSaved(true); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>{saved ? <Check /> : <Save />}<span>{saved ? '已保存' : eventId ? '保存 Cue' : '添加 Cue'}</span></button>
  </aside>;
}
