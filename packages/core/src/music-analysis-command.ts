import { createLightingDocument, musicStructureSchema, type LinkProject, type MusicStructure, type ReferenceAudio } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { matchingMusicStructure } from './music-structure';

/** Background analysis adds source-bound metadata without replacing user edits or undo history. */
export function setAutomaticMusicAnalysisCommand(itemId: string, source: ReferenceAudio, input: MusicStructure): LinkCommand {
  const analysis = musicStructureSchema.parse(input);
  const fingerprint = { sha256: source.sha256, durationMs: source.durationMs };
  if (analysis.sourceSha256 !== fingerprint.sha256 || Math.abs(analysis.durationMs - fingerprint.durationMs) > 50) throw new Error('音源或裁剪已改变，本次分析不能应用');
  const matches = (audio: ReferenceAudio | undefined): boolean => audio?.sha256 === fingerprint.sha256 && audio.durationMs === fingerprint.durationMs;
  const apply = (project: LinkProject): LinkProject => {
    const rundown = project.rundown.map(item => {
      if (item.id !== itemId || !matches(item.referenceAudio) || matchingMusicStructure(item.lighting, fingerprint)) return item;
      return { ...item, lighting: { ...(item.lighting ?? createLightingDocument()), version: 2 as const, musicAnalysis: structuredClone(analysis) } };
    });
    return rundown.every((item, index) => item === project.rundown[index]) ? project : { ...project, schemaVersion: 2, rundown };
  };
  return {
    id: crypto.randomUUID(), label: '自动识别音乐节拍与段落', scope: 'lighting',
    historyRebaseKey: `music-analysis:${itemId}:${fingerprint.sha256}:${fingerprint.durationMs}`,
    rebaseHistory: apply,
    execute(project) {
      if (!matches(project.rundown.find(item => item.id === itemId)?.referenceAudio)) throw new Error('音源或节目已改变，本次分析不能应用');
      return { ...apply(project), updatedAt: new Date().toISOString() };
    },
    undo: before => before
  };
}
