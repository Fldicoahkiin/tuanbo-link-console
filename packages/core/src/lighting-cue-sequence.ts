import type { LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';

/** Master points share the track binding without consuming the next Cue. */
export function nextLightingMaster(document: LightingDocument, track: LightingTrack, ms: number): Pick<Extract<LightingEvent, { kind: 'ma2-fader' }>, 'executor' | 'fader' | 'level' | 'label'> {
  if (track.kind !== 'ma2' || !Number.isFinite(ms) || ms < 0) throw new Error('主推杆需要有效的灯光轨道和时间');
  const bindings = document.ma2Bindings?.filter((binding) => binding.baselineTracks.some((entry) => entry.id === track.id) || binding.pendingTracks?.some((entry) => entry.trackId === track.id)) ?? [];
  if (bindings.length > 1) throw new Error('灯光轨道对应多个 MA2 绑定，请先检查设置');
  const binding = bindings[0];
  const boundExecutor = binding?.pendingTracks?.find((entry) => entry.trackId === track.id)?.executor ?? binding?.trackMappings?.find((entry) => entry.trackId === track.id)?.executor ?? binding?.mappings.find((entry) => entry.trackId === track.id)?.executor;
  if (binding && !boundExecutor) throw new Error('灯光轨道缺少 MA2 执行器绑定，请先检查设置');
  const map = new LightingTempoMap(document.tempos);
  const preceding = track.clips.flatMap((clip) => clip.events.flatMap((event) => (event.kind === 'ma2' || event.kind === 'ma2-fader') && lightingEventTime(clip, event, map) <= ms ? [{ event, ms: lightingEventTime(clip, event, map) }] : [])).sort((a, b) => a.ms - b.ms);
  const executor = boundExecutor ?? (track.cueStamp?.mode === 'fixed' ? track.cueStamp.executor : preceding.at(-1)?.event.executor) ?? '1.1';
  const previous = preceding.filter(({ event }) => event.kind === 'ma2-fader' && event.executor === executor).at(-1)?.event;
  return { executor, fader: 'Master', level: previous?.kind === 'ma2-fader' ? previous.level : 1, label: '主推杆' };
}

/** Seed fixed stamping from the first musical Cue, or the bound console catalog. */
export function createFixedLightingCueStamp(document: LightingDocument, track: LightingTrack): Extract<NonNullable<LightingTrack['cueStamp']>, { mode: 'fixed' }> {
  const map = new LightingTempoMap(document.tempos);
  const first = track.clips.flatMap((clip) => clip.events.flatMap((event) => event.kind === 'ma2' && event.action === 'goto' ? [{ event, ms: lightingEventTime(clip, event, map) }] : []))
    .sort((a, b) => a.ms - b.ms)[0]?.event;
  const cue = first ?? nextLightingCue(document, { ...track, cueStamp: { mode: 'sequence' }, clips: [] }, 0);
  if (cue.cue === undefined || cue.sequence === undefined) throw new Error('灯光 Cue 缺少序列或编号，请先检查属性');
  const stamp = { mode: 'fixed' as const, cue: cue.cue, sequence: cue.sequence, executor: cue.executor };
  nextLightingCue(document, { ...track, cueStamp: stamp }, 0);
  return stamp;
}

/** Pick the preceding point by musical position, not by array insertion order. */
export function nextLightingCue(document: LightingDocument, track: LightingTrack, ms: number): Pick<Extract<LightingEvent, { kind: 'ma2' }>, 'cue' | 'sequence' | 'executor' | 'label'> {
  if (track.cueStamp?.mode === 'marker') throw new Error('标记模式不生成控台 Cue');
  const bindings = document.ma2Bindings?.filter((binding) => binding.baselineTracks.some((entry) => entry.id === track.id) || binding.pendingTracks?.some((entry) => entry.trackId === track.id)) ?? [];
  if (bindings.length > 1) throw new Error('灯光轨道对应多个 MA2 绑定，请先检查设置');
  const binding = bindings[0];
  const pending = binding?.pendingTracks?.find((entry) => entry.trackId === track.id);
  const executor = pending?.executor ?? binding?.trackMappings?.find((entry) => entry.trackId === track.id)?.executor ?? binding?.mappings.find((entry) => entry.trackId === track.id)?.executor;
  if (binding && !executor) throw new Error('灯光轨道缺少 MA2 执行器绑定，请先检查设置');
  if (track.cueStamp?.mode === 'fixed') {
    if (binding && track.cueStamp.executor !== executor) throw new Error(`固定 Cue 的执行器与轨道绑定不一致，请在灯光设置中改为 ${executor}`);
    return { cue: track.cueStamp.cue, sequence: track.cueStamp.sequence, executor: track.cueStamp.executor, label: `Cue ${Number(track.cueStamp.cue)}` };
  }
  const map = new LightingTempoMap(document.tempos);
  const preceding = track.clips.flatMap((clip) => clip.events.flatMap((event) => event.kind === 'ma2' && event.action === 'goto' && lightingEventTime(clip, event, map) <= ms ? [{ event, ms: lightingEventTime(clip, event, map) }] : []))
    .sort((a, b) => a.ms - b.ms).at(-1)?.event;
  if (!binding) {
    const cue = String(Math.floor(Number(preceding?.cue ?? 0)) + 1);
    return { cue, sequence: preceding?.sequence ?? 1, executor: preceding?.executor ?? '1.1', label: `灯光 ${cue}` };
  }
  const references = [...new Set(binding.mappings.filter((entry) => (entry.trackId === track.id || pending?.executor === entry.executor) && entry.sequence !== null).map((entry) => entry.sequence!))];
  const sequence = preceding?.sequence ?? pending?.sequence ?? (references.length === 1 ? references[0] : binding.cueCatalog?.length === 1 ? binding.cueCatalog[0]?.sequence : undefined);
  if (sequence === undefined) throw new Error('请先在灯光点属性中指定序列，再继续打点');
  const catalog = binding.cueCatalog?.find((entry) => entry.sequence === sequence);
  if (!catalog) throw new Error(`尚未读取序列 ${sequence} 的 Cue 列表，请到设置中读取并同步 MA2`);
  const cues = [...catalog.cues].sort((a, b) => a.index - b.index);
  const previousIndex = preceding ? cues.findIndex((cue) => Number(cue.number) === Number(preceding.cue)) : -1;
  if (preceding && previousIndex < 0) throw new Error(`序列 ${sequence} 的 Cue 列表中没有 ${preceding.cue}，请重新读取 MA2`);
  const next = cues[previousIndex + 1];
  if (!next) throw new Error(`序列 ${sequence} 的 Cue 已全部打完`);
  if (!executor) throw new Error('灯光轨道缺少 MA2 执行器绑定，请先检查设置');
  return { sequence, executor, cue: next.number, label: next.name ?? `Cue ${Number(next.number)}` };
}
