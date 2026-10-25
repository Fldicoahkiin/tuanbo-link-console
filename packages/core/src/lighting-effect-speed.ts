import { LIGHTING_EFFECT_BPM, lightingDocumentSchema, type LightingDocument, type LightingEffectSpeed, type LightingEvent } from '@tb/schema';
import { LightingTempoMap } from './lighting-edit';

/** The song's tempo at a song-relative time. The beat grid starts at the music's first beat. */
export function songBpmAt(document: Pick<LightingDocument, 'tempos' | 'music'>, ms: number): number {
  return new LightingTempoMap(document.tempos).rateAt(Math.max(0, ms - (document.music?.firstBeatMs ?? 0))).bpm;
}

/** Effect speeds are written in hundredths of a BPM, so a speed read back compares equal. */
const hundredths = (value: number): number => Math.round(value * 100) / 100;

/** The BPM a step at `ms` runs its effects at. A speed the console range cannot take is an error, never clamped. */
export function lightingEffectBpm(document: Pick<LightingDocument, 'tempos' | 'music'>, speed: LightingEffectSpeed, ms: number): number {
  const bpm = hundredths(speed.mode === 'fixed' ? speed.bpm : songBpmAt(document, ms) / speed.beats);
  if (bpm < LIGHTING_EFFECT_BPM.min || bpm > LIGHTING_EFFECT_BPM.max) throw new Error(`效果速度 ${bpm} BPM 超出 ${LIGHTING_EFFECT_BPM.min}–${LIGHTING_EFFECT_BPM.max} BPM，请换一档或改填固定速度`);
  return bpm;
}

type CueEvent = Extract<LightingEvent, { kind: 'ma2' }>;
/** Events that make up one timeline point: the event itself, or every member of its group. */
const pointId = (event: LightingEvent): string => event.effectGroupId ?? event.id;
const speedTarget = (event: LightingEvent): event is CueEvent => event.kind === 'ma2' && event.action === 'goto' && !event.preparation;

/**
 * The effect speed set on a timeline point. Every Cue in a combined point carries the same one;
 * members that disagree are an error rather than a guess at which one counts.
 */
export function lightingPointEffectSpeed(events: readonly LightingEvent[], name: string): LightingEffectSpeed | undefined {
  const speeds = new Set(events.filter(speedTarget).map(event => JSON.stringify(event.effectSpeed ?? null)));
  if (speeds.size > 1) throw new Error(`“${name || '未命名 Cue'}”的组合素材效果速度不一致，请重新设置这个点的效果速度`);
  return events.filter(speedTarget).find(event => event.effectSpeed)?.effectSpeed;
}

/** Sets, or with `undefined` clears, the effect speed of the point an event belongs to. */
export function setLightingEffectSpeed(document: LightingDocument, eventId: string, speed: LightingEffectSpeed | undefined): LightingDocument {
  const all = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.map(event => ({ track, event }))));
  const selected = all.find(value => value.event.id === eventId)?.event;
  if (!selected) throw new Error('Cue 已不存在');
  const id = pointId(selected);
  const members = all.filter(value => pointId(value.event) === id);
  if (!members.some(value => speedTarget(value.event))) throw new Error('只有调用指定 Cue 的点可以设效果速度');
  if (members.some(value => value.track.locked)) throw new Error('轨道已锁定，不能修改效果速度');
  return lightingDocumentSchema.parse({ ...document, version: 2, tracks: document.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.map((event): LightingEvent => {
    if (pointId(event) !== id || !speedTarget(event)) return event;
    const rest = { ...event }; delete rest.effectSpeed;
    return speed ? { ...rest, effectSpeed: speed } : rest;
  }) })) })) });
}
