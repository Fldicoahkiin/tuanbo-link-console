import { automaticMusicCandidatesSchema, createLightingMusic, lightingDocumentSchema, type AutomaticMusicRun, type AutomaticMusicCandidates, type LightingDocument, type ReferenceAudio } from '@tb/schema';
import { fuseMusicBeats } from './music-beat-fusion';

/** Scoped to annotations produced for this source; manual annotations and console objects are untouched. */
export function removeAutomaticMusicAnnotations(document: LightingDocument, hash: string, ids?: ReadonlySet<string>): LightingDocument {
  const remove = (id: string): boolean => (id.startsWith(`analysis:${hash}:`) || id.startsWith(`music-beat:${hash}:`)) && (!ids || ids.has(id));
  return lightingDocumentSchema.parse({ ...document, markers: document.markers.filter(marker => !remove(marker.id)),
    ...(document.music ? { music: { ...document.music, sections: document.music.sections.filter(section => !remove(section.id)) } } : {}) });
}

/** Exposes model predictions for human review, without claiming calibrated accuracy. */
export function automaticMusicCandidates(run: AutomaticMusicRun): AutomaticMusicCandidates {
  const beats = fuseMusicBeats(run);
  const structure = run.diagnostics['audio-structure'] ?? run.diagnostics['all-in-one'];
  const intervals = (beats?.beats ?? []).slice(1).map((at, i) => at - beats.beats[i]!).filter(value => value > 0).sort((a, b) => a - b);
  const median = intervals.length ? intervals[Math.floor(intervals.length / 2)]! : null;
  const stableIntervals = median ? intervals.filter(value => Math.abs(value / median - 1) <= .1) : [];
  const typicalPeriod = stableIntervals.length ? stableIntervals.reduce((sum, value) => sum + value, 0) / stableIntervals.length : null;
  const items: AutomaticMusicCandidates['items'] = [];
  for (const kind of ['beat', 'downbeat'] as const) for (const [i, at] of (kind === 'beat' ? beats?.beats ?? [] : beats?.downbeats ?? []).entries()) {
    items.push({ id: `${kind}:${at}`, kind, name: `${kind === 'beat' ? '节拍' : '小节第一拍'} ${i + 1}`, startMs: at * 1000, endMs: null });
  }
  for (const [i, section] of (structure?.sections ?? []).entries()) items.push({ id: `section:${section.start}:${section.end}`, kind: 'section', name: `段落 ${i + 1}`, startMs: section.start * 1000, endMs: section.end * 1000 });
  return automaticMusicCandidatesSchema.parse({ sourceSha256: run.audio.source_sha256, durationMs: run.audio.sample_count / run.audio.sample_rate * 1000, bpm: typicalPeriod && !beats.ambiguous ? Math.round(6000 / typicalPeriod) / 100 : null, items: items.sort((a, b) => a.startMs - b.startMs) });
}

/** Called by a single LinkCommand; existing cues, tempo, MTC and manual annotations are untouched. */
export function applyAutomaticMusicCandidates(document: LightingDocument, source: ReferenceAudio, candidates: AutomaticMusicCandidates, selected: ReadonlySet<string>): LightingDocument {
  const valid = automaticMusicCandidatesSchema.parse(candidates);
  if (source.sha256 !== valid.sourceSha256 || Math.abs(source.durationMs - valid.durationMs) > 50) throw new Error('音源或裁剪已改变，请重新分析当前音乐');
  const chosen = valid.items.filter(item => selected.has(item.id));
  if (!chosen.length) throw new Error('请选择要应用的分析结果');
  if (chosen.length !== selected.size) throw new Error('分析结果已改变，请重新选择');
  const music = document.music ?? createLightingMusic();
  const markers = [...document.markers]; const sections = [...music.sections];
  for (const item of chosen) {
    const id = `analysis:${source.sha256}:${item.id}`;
    const color = item.kind === 'section' ? '#bb91e8' : item.kind === 'downbeat' ? '#eabb68' : '#68c9ed';
    const notes = `音乐分析建议，经用户确认；音源 ${source.sha256}`;
    if (item.kind === 'section' && item.endMs !== null) {
      if (sections.some(section => section.id === id)) continue;
      if (sections.some(section => item.startMs < section.endMs && item.endMs! > section.startMs)) throw new Error(`“${item.name}”与已有段落重叠，请取消选择或先调整已有段落`);
      sections.push({ id, name: item.name, startMs: item.startMs, endMs: item.endMs, color, notes });
    } else if (!markers.some(marker => marker.id === id)) markers.push({ id, name: item.name, kind: 'custom', startMs: item.startMs, endMs: null, color, notes });
  }
  return lightingDocumentSchema.parse({ ...document, version: 2, music: { ...music, sections: sections.sort((a, b) => a.startMs - b.startMs) }, markers });
}
