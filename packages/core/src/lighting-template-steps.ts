import { lightingDocumentSchema, type LightingDocument } from '@tb/schema';
import { assertMusicCueConflicts } from './lighting-music';
import { LightingTempoMap } from './lighting-edit';
import type { SongBeats } from './song-beats';

export type LightingTemplateSequence = { sequence: number; complete: boolean; cues: { number: string; name: string | null }[] };
type Template = LightingDocument['templates'][number];
export type LightingTemplateStep = { name: string; sequence: number; cue: string; executor: string; delayMs: number };

/** Every material placement expands whole sequences here; sequence steps remain separate Cue points. */
export function lightingTemplateSteps(document: LightingDocument, template: Template, sequences: readonly LightingTemplateSequence[], startMs: number, intervalBeats = 1, song?: SongBeats): LightingTemplateStep[] {
  const stamp = template.track.cueStamp;
  if (stamp?.mode !== 'fixed') throw new Error('这个素材还没有关联 Cue');
  if (!template.nativeSequence) return template.members?.map(member => ({ ...member })) ?? [{ ...stamp, name: template.name, delayMs: 0 }];
  const sequence = sequences.find(value => value.sequence === stamp.sequence);
  if (!sequence?.complete || !sequence.cues.length) throw new Error(`序列 ${stamp.sequence} 的全部 Cue 还没读完整，请先读取控台素材`);
  return lightingSequenceSteps(document, sequence, stamp.executor, startMs, intervalBeats, song);
}

export function lightingSequenceSteps(document: LightingDocument, sequence: LightingTemplateSequence, executor: string, startMs: number, intervalBeats = 1, song?: SongBeats): LightingTemplateStep[] {
  if (!sequence.complete || !sequence.cues.length) throw new Error('整套 Cue 还没读完整，请先读取控台素材');
  if (!Number.isFinite(intervalBeats) || intervalBeats <= 0) throw new Error('每步间隔必须大于零拍');
  const tempo = new LightingTempoMap(document.tempos);
  const beat = tempo.msToBeat(Math.max(0, startMs - (document.music?.firstBeatMs ?? 0)));
  const marks = song?.state === 'ready' ? [...new Set(song.beats.map(value => value.atMs))].sort((a, b) => a - b) : [];
  // Preserve the chosen start, including a fractional beat. Interpolate the song's actual placed beats;
  // outside their range extend the nearest interval, with the song end checked by the placement command.
  const next = marks.findIndex(ms => ms > startMs);
  const left = next < 0 ? marks.length - 2 : Math.max(0, next - 1);
  const position = marks.length > 1 ? left + (startMs - marks[left]!) / (marks[left + 1]! - marks[left]!) : 0;
  const atBeat = (value: number): number => {
    const index = Math.max(0, Math.min(marks.length - 2, Math.floor(value)));
    return marks[index]! + (value - index) * (marks[index + 1]! - marks[index]!);
  };
  return sequence.cues.map((cue, index) => ({ name: cue.name ?? `Cue ${Number(cue.number)}`, sequence: sequence.sequence, cue: cue.number, executor,
    delayMs: index === 0 ? 0 : marks.length > 1 ? atBeat(position + index * intervalBeats) - startMs : tempo.beatToMs(beat + index * intervalBeats) - tempo.beatToMs(beat) }));
}

type Stamp = { effectId: string; ms: number; id: string; groupId?: string | undefined };
export function placeLightingTemplate(document: LightingDocument, stamp: Stamp, durationMs: number, sequences: readonly LightingTemplateSequence[] = [], intervalBeats = 1, beats?: SongBeats): LightingDocument {
  if (!Number.isFinite(stamp.ms) || stamp.ms < 0 || stamp.ms >= durationMs) throw new Error('Cue 超出歌曲范围');
  const effect = document.templates.find(entry => entry.id === stamp.effectId);
  const binding = effect?.track.cueStamp;
  if (!effect || binding?.mode !== 'fixed') throw new Error('请先绑定灯光效果');
  if (binding.executor && !/^[1-9]\d*\.[1-9]\d*$/.test(binding.executor)) throw new Error('这个素材还没绑定执行器，请在素材设置里填写“页号.执行器编号”');
  if (effect.members || effect.nativeSequence) {
    const steps = lightingTemplateSteps(document, effect, sequences, stamp.ms, intervalBeats, beats);
    if (steps.some(member => stamp.ms + member.delayMs >= durationMs)) throw new Error('整套 Cue 超出了歌曲结尾，请减小每步间隔或往前放');
    return [...steps].sort((a, b) => a.delayMs - b.delayMs).reduce((result, member, index) => {
      const temporary = { ...effect, name: member.name, nativeSequence: false, members: undefined, track: { ...effect.track, cueStamp: { mode: 'fixed' as const, sequence: member.sequence, cue: member.cue, executor: member.executor } } };
      const value = placeLightingTemplate({ ...result, templates: result.templates.map(entry => entry.id === effect.id ? temporary : entry) }, { ...stamp, ms: stamp.ms + member.delayMs, id: index === 0 ? stamp.id : crypto.randomUUID(), groupId: effect.nativeSequence ? undefined : stamp.id }, durationMs);
      return { ...value, templates: document.templates };
    }, document);
  }
  const existing = document.tracks.find(track => track.group === 'effect-canvas' && track.cueStamp?.mode === 'fixed' && track.cueStamp.executor === binding.executor && (binding.executor || track.cueStamp.sequence === binding.sequence) && !track.locked);
  const track = existing ?? { ...effect.track, id: crypto.randomUUID(), name: '灯光', group: 'effect-canvas', clips: [] };
  const event = { id: stamp.id, librarySource: { id: effect.id, revision: effect.libraryRevision ?? 1 }, ...(stamp.groupId ? { effectGroupId: stamp.groupId } : {}), kind: 'ma2' as const, action: 'goto' as const, label: effect.name, at: stamp.ms, executor: binding.executor, sequence: binding.sequence, cue: binding.cue };
  const clip = track.clips.find(entry => entry.timeLock === 'time' && entry.start === 0 && !entry.muted);
  const updatedClip = clip ? { ...clip, duration: Math.max(clip.duration, stamp.ms + 1), events: [...clip.events, event] } : { id: crypto.randomUUID(), name: effect.name, start: 0, duration: Math.max(durationMs, stamp.ms + 1), timeLock: 'time' as const, muted: false, events: [event] };
  const updated = { ...track, clips: [...track.clips.filter(entry => entry.id !== clip?.id), updatedClip] };
  const result = lightingDocumentSchema.parse({ ...document, version: 2, tracks: existing ? document.tracks.map(entry => entry.id === track.id ? updated : entry) : [...document.tracks, updated] });
  assertMusicCueConflicts(result); return result;
}
