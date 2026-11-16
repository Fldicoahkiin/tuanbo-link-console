import type { LightingDocument } from '@tb/schema';
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
