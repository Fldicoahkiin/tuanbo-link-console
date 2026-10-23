import { useEffect, useState } from 'react';
import { PropertyNumberInput } from './PropertyNumberInput';
import { X, Check, Save, Layers } from 'lucide-react';
import { LightingTempoMap, lightingEventTime, removeLightingEffects, placeEmptyLightingCue } from '@tb/core/link';
import { lightingDocumentSchema, lightingTrackSchema, type LightingDocument, type LightingEvent } from '@tb/schema';
import { placeEffect } from './useLightingEffectStamp';
import { LightingCuePreparation } from './LightingCuePreparation';
import { CONSOLE_CUE_DRAG } from './lighting-material-drag';
import { Ma2ConsoleName } from './Ma2ConsoleName';
import { ma2ConsoleCuePoolName, ma2ConsoleSequenceName, ma2SequenceLibrary, type LibrarySequence } from '../view-models/ma2-sequence-library';

export type CueIngredient = { name: string; sequenceName?: string; sequence: number; cue: string; executor: string; delayMs: number; preparation?: Extract<LightingEvent, { kind: 'ma2' }>['preparation'] };
export function cueIngredients(document: LightingDocument, eventId?: string, library: readonly LibrarySequence[] = ma2SequenceLibrary(null, document)): CueIngredient[] {
  if (!eventId) return [];
  const map = new LightingTempoMap(document.tempos);
  const times = new Map(document.tracks.flatMap(track=>track.clips.flatMap(clip=>clip.events.map(event=>[event.id,lightingEventTime(clip,event,map)] as const))));
  const events = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
  const first = Math.min(...events.filter(event=>event.id===eventId||event.effectGroupId===eventId).map(event=>times.get(event.id)!));
  return events.flatMap(event => {
    if (event.kind !== 'ma2' || !(event.id === eventId || event.effectGroupId === eventId) || !event.sequence || !event.cue) return [];
    const sequence = library.find(value => value.sequence === event.sequence);
    const cue = sequence?.cues.find(value => Number(value.number) === Number(event.cue));
    const source = document.templates.find(effect => { const binding = effect.track.cueStamp; return binding?.mode === 'fixed' && binding.sequence === event.sequence && Number(binding.cue) === Number(event.cue) && binding.executor === event.executor; });
    // The event label belongs to the timeline point; material names come from the saved console catalog.
    const name = sequence && cue ? ma2ConsoleCuePoolName(sequence, cue) : source?.name ?? (event.label || `Cue ${Number(event.cue)}`);
    return [{ name, ...(sequence ? { sequenceName: ma2ConsoleSequenceName(sequence) } : {}), sequence: event.sequence, cue: event.cue, executor: event.executor, delayMs: times.get(event.id)! - first, ...(event.preparation ? { preparation: event.preparation } : {}) }];
  });
}
export function saveCueIngredients(document: LightingDocument, ingredients: CueIngredient[], name: string, ms: number, durationMs: number, eventId?: string): LightingDocument {
  const original = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === eventId || event.effectGroupId === eventId);
  const runMode = original?.kind === 'ma2' || original?.kind === 'empty-cue' && original.runMode ? original.runMode : document.outputMode === 'timecode' ? undefined : 'independent';
  if (!ingredients.length) return placeEmptyLightingCue(document, eventId ?? crypto.randomUUID(), ms, durationMs, name.trim());
  if (ingredients.some(entry => entry.executor && !/^[1-9]\d*\.[1-9]\d*$/.test(entry.executor))) throw new Error('执行器格式应为页号.编号；留空即可使用序列池');
  if (new Set(ingredients.map(entry => `${entry.executor ? `executor:${entry.executor}` : `sequence:${entry.sequence}`}:${entry.delayMs}`)).size !== ingredients.length) throw new Error('同一序列池序列或同一执行器在同一时间只能使用一个 Cue，请调整组合延迟或移除冲突素材');
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
  const temporary = { ...first, id: crypto.randomUUID(), name: name.trim() || 'Cue 素材', track: { ...track, cueStamp: { mode: 'fixed' as const, sequence: ingredient.sequence, cue: ingredient.cue, executor: ingredient.executor } }, members: ingredients.length > 1 ? ingredients.map(({ name, sequence, cue, executor, delayMs }) => ({ name, sequence, cue, executor, delayMs })) : undefined };
  const id = eventId ?? crypto.randomUUID();
  const placed = placeEffect({ ...base, templates: [...base.templates, temporary] }, { effectId: temporary.id, ms, id }, durationMs);
  const result = retainCueLocations(document, placed, id, ms, map);
  return lightingDocumentSchema.parse({ ...result, templates: document.templates, tracks: result.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.map(event => {
    if (event.kind !== 'ma2' || (event.id !== id && event.effectGroupId !== id)) return event;
    const eventMs = result.tracks.flatMap(track=>track.clips.flatMap(clip=>clip.events.filter(value=>value.id===event.id).map(value=>lightingEventTime(clip,value,map))))[0] ?? ms;
    const source = ingredients.find(entry => entry.sequence === event.sequence && entry.executor === event.executor && entry.cue === event.cue && Math.abs(entry.delayMs - (eventMs-ms))<.001);
    const detached={...event};delete detached.librarySource;
    return { ...detached, runMode, ...(event.id === id ? { label: name.trim() } : {}), ...(source?.preparation ? { preparation: source.preparation } : {}) };
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
    const generatedMs = placed.tracks.flatMap(track=>track.clips.flatMap(clip=>clip.events.filter(value=>value.id===event.id).map(value=>lightingEventTime(clip,value,map))))[0] ?? ms;
    const at = (slot.clip.timeLock === 'time' ? generatedMs : map.msToBeat(generatedMs)) - slot.clip.start;
    if (at < 0) throw new Error('组合的正式时间早于原片段起点，请先调整片段');
    moved.set(event.id, { clipId: slot.clip.id, event: { ...event, id: slot.event.id, at } });
  });
  const tracks = placed.tracks.map(track => ({ ...track, clips: track.clips.map(clip => {
    const restored = [...moved.values()].filter(value => value.clipId === clip.id).map(value => value.event);
    return { ...clip, duration: Math.max(clip.duration, ...restored.map(event => event.at + 1)), events: [...clip.events.filter(event => !moved.has(event.id)), ...restored] };
  }) })).filter(track => before.tracks.some(old => old.id === track.id) || track.clips.some(clip => clip.events.length));
  return { ...placed, tracks };
}

export function LightingCueComposer({ templateId, document, eventId, ms, durationMs, ingredients, onIngredients, onChange, onNew, disabled, details, onDropMaterial }: { onDropMaterial?: (transfer: DataTransfer) => void; templateId?: string | undefined; details: boolean; document: LightingDocument; eventId?: string | undefined; ms: number; durationMs: number; ingredients: CueIngredient[]; onIngredients: (values: CueIngredient[]) => void; onChange: (document: LightingDocument, label: string) => boolean | void; onNew: () => void; disabled: boolean }): JSX.Element {
  const [name, setName] = useState(() => document.templates.find(value=>value.id===templateId)?.name ?? document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.flatMap(event => (event.kind === 'ma2' || event.kind === 'empty-cue') && event.id === eventId ? [event.label] : [])))[0] ?? '');
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<string>();
  const [savedSignature, setSavedSignature] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const targetId = eventId ?? createdId;
  const tempoMap = new LightingTempoMap(document.tempos);
  const cueTime = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.id === targetId).map(event => lightingEventTime(clip, event, tempoMap))))[0] ?? ms;
  const signature = JSON.stringify({ ingredients, name, ms: cueTime });
  const stored = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === targetId);
  const storedName = stored && 'label' in stored ? stored.label : undefined;
  useEffect(() => { if (!editingName && storedName !== undefined) setName(storedName); }, [storedName, editingName]);
  const contents = (values: CueIngredient[]): string => JSON.stringify(values.map(({ sequence, cue, executor, delayMs, preparation }) => ({ sequence, cue, executor, delayMs, preparation })));
  const saved = savedSignature === signature || (storedName === name.trim() && contents(cueIngredients(document, targetId)) === contents(ingredients));
  const setSaved = (value: boolean): void => setSavedSignature(value ? signature : '');
  return <aside className="cue-composer" data-drop-active={dragOver} aria-label={details ? '点位素材组合' : 'Cue 组合编辑'}
    onDragOver={event => { if (disabled || !event.dataTransfer.types.some(type => type === CONSOLE_CUE_DRAG || type === 'application/x-tblink-lighting-effect')) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDragOver(true); }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragOver(false); if (!disabled) onDropMaterial?.(event.dataTransfer); }}>
    <header className="cue-composer-heading"><strong>{targetId ? '编辑 Cue' : '组合 Cue'}</strong><span>{(cueTime / 1000).toFixed(3)} 秒</span><button className="cue-save" aria-label={eventId || createdId ? '保存 Cue' : '添加 Cue'} disabled={disabled || saved || durationMs <= 0} onClick={() => { try { const id = eventId ?? createdId ?? crypto.randomUUID(); const result = onChange(saveCueIngredients(document, ingredients, name, ms, durationMs, id), '保存 Cue 组合'); if (result === false) { setError('保存失败，请处理提示后重试'); return; } setCreatedId(id); setError(''); setSaved(true); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>{saved ? <Check /> : <Save />}<span>{saved ? '已保存' : eventId || createdId ? '保存修改' : '添加到时间线'}</span></button><button title="关闭编辑" aria-label="关闭 Cue 编辑" onClick={onNew}><X /></button></header>
    <input className="cue-name-input" aria-label="Cue 名称" placeholder="Cue 名称" value={name} disabled={disabled} onFocus={() => setEditingName(true)} onChange={event => { setName(event.target.value); setSaved(false); }} onBlur={() => {
      setEditingName(false);
      if (!targetId || disabled || name.trim() === storedName) return;
      try { if (onChange(saveCueIngredients(document, ingredients, name, ms, durationMs, targetId), '重命名 Cue') === false) throw new Error('Cue 名称保存失败'); setError(''); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }} />
    {document.consoleSong?.points.some(point => point.id === targetId) ? <small className="cue-console-address">{document.consoleSong.executor ? `按钮第 ${document.consoleSong.executor.split('.')[0]} 页 · ${document.consoleSong.executor.split('.')[1]} 格` : `Layout ${document.consoleSong.layout}`} · 序列 {document.consoleSong.sequence} · Cue {Number(document.consoleSong.points.find(point => point.id === targetId)?.cue)}</small> : null}
    {document.consoleSong?.points.some(point => point.id === targetId) ? <Ma2ConsoleName name={name}/> : null}
    {stored?.kind === 'ma2' || stored?.kind === 'empty-cue' ? <div className="cue-run-settings">
      <div className="cue-run-mode" role="group" aria-label="Cue 运行方式">{([['independent', '单独运行'], ['follow', '跟随上一个']] as const).map(([value, title]) => <button key={value} aria-pressed={(stored.runMode ?? 'follow') === value} disabled={disabled || value === 'independent' && document.outputMode === 'timecode'} onClick={() => {
        try {
          const groupId = stored.effectGroupId ?? stored.id;
          const next = lightingDocumentSchema.parse({ ...document, version: 2, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.map(event => (event.kind === 'ma2' || event.kind === 'empty-cue') && (event.effectGroupId ?? event.id) === groupId ? { ...event, runMode: value } : event) })) })) });
          if (onChange(next, `Cue ${title}`) === false) throw new Error('运行方式保存失败');
          setError('');
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>{title}</button>)}</div>
      <small>{document.outputMode === 'timecode' ? '时间码跟随的工程由控台按时间线运行，不能选单独运行。' : stored.runMode === 'independent' ? '结束前面的灯光组合，再运行本 Cue。' : '保留前面的灯光组合，叠加运行本 Cue。'}{stored.kind === 'ma2' && stored.preparation ? ' 埋步开始时执行切换。' : ''}{stored.kind === 'empty-cue' ? ' 空点位暂不发指令；添加灯光或同步控台后生效。' : ''}</small>
    </div> : null}
    <div className="cue-composer-body"><div className="cue-content-heading"><span>包含素材</span><small>{ingredients.length}</small></div>
    <div className="cue-ingredients" aria-label="Cue 内容">{ingredients.map((entry, index) => <div className="cue-ingredient" key={`${entry.sequence}:${entry.executor}:${entry.cue}:${entry.delayMs}`}>
      <div className="cue-ingredient-title"><Layers /><strong title={entry.name}>{entry.name}</strong><button disabled={disabled} aria-label={`移除素材 ${entry.name}`} onClick={() => { onIngredients(ingredients.filter((_, i) => i !== index)); setSaved(false); }}><X /></button></div>
      <details><summary>{entry.sequenceName && entry.sequenceName !== entry.name ? `${entry.sequenceName} · ` : ''}序列 {entry.sequence} · Cue {Number(entry.cue)}{entry.delayMs ? ` · +${entry.delayMs} ms` : ''}</summary><div className="cue-ingredient-fields">
        <label>序列<PropertyNumberInput label={`素材 ${index + 1} 序列`} min={1} max={99999} value={entry.sequence} disabled={disabled} onCommit={value => onIngredients(ingredients.map((item, i) => i === index ? { ...item, sequence: value } : item))} /></label>
        <label>Cue 编号<input aria-label={`素材 ${index + 1} Cue 编号`} key={entry.cue} defaultValue={entry.cue} disabled={disabled} onBlur={event => onIngredients(ingredients.map((item, i) => i === index ? { ...item, cue: event.target.value } : item))} /></label>
        <label>延迟 ms<PropertyNumberInput label={`素材 ${index + 1} 延迟`} min={0} max={86400000} value={entry.delayMs} disabled={disabled} onCommit={value => onIngredients(ingredients.map((item, i) => i === index ? { ...item, delayMs: value } : item))} /></label>
        <label>执行器<input placeholder="序列池" aria-label={`素材 ${index + 1} 执行器`} key={entry.executor} defaultValue={entry.executor} disabled={disabled} onBlur={event => onIngredients(ingredients.map((item, i) => i === index ? { ...item, executor: event.target.value } : item))} /></label>
      </div></details>
    </div>)}</div>
    <div className="cue-drop-hint"><Layers /><span>{ingredients.length ? '拖入素材，或点素材上的 ＋' : '空 Cue · 拖入素材，或点素材上的 ＋'}</span></div>
    {eventId ? <small>素材修改自动保存；空 Cue 不发送灯光指令。</small> : null}
    {ingredients.length ? <LightingCuePreparation document={document} ingredients={ingredients} onChange={onIngredients} cueTime={cueTime} disabled={disabled} /> : null}
    {ingredients.some(entry => entry.preparation) ? <small>埋步不能写入控台，含埋步时本曲无法同步到控台，演出没有灯光。请去掉埋步。</small> : null}
    <details className="cue-composer-advanced"><summary>存入素材库</summary><button disabled={disabled || !ingredients.length || !name.trim()} onClick={() => { try { const first = ingredients[0]!; const track = lightingTrackSchema.parse({id:crypto.randomUUID(),name:name.trim(),kind:'ma2',color:'#68c9ed',group:'',muted:false,solo:false,locked:false,channel:1,controller:7,portProfileId:'',noteNames:{},clips:[],cueStamp:{mode:'fixed',sequence:first.sequence,cue:first.cue,executor:first.executor}});const previous=document.templates.find(value=>value.id===templateId);const template={...previous,id:previous?.id ?? crypto.randomUUID(),name:name.trim(),track,nativeSequence:false,members:ingredients.map(({name,sequence,cue,executor,delayMs})=>({name,sequence,cue,executor,delayMs}))};const result=onChange({...document,templates:[...document.templates.filter(value=>value.id!==template.id),template]},'收藏灯光组合');if(result===false)throw new Error('保存组合失败');setError(''); } catch(cause){setError(cause instanceof Error ? cause.message : String(cause));} }}>{templateId ? '保存分类素材修改' : '保存为分类素材'}</button></details>
    {error ? <p role="alert">{error}</p> : null}

    {durationMs <= 0 ? <small>请先为当前节目添加音频。</small> : null}
    </div>
  </aside>;
}
