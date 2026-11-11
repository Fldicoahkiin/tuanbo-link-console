import { songMusicSchema, type LinkProject, type ReferenceAudioSource, type SongMusic } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { withSchemaVersion } from './project-schema-version';
import { songMusicAudio } from './song-beats';

/**
 * Sets a song's beats (`rundownItem.music`), the only place they are kept. It changes the song, never its lighting
 * document, so the MA2 pending changes (kept per `item.lighting`) stay as they are.
 * - `background`: a finished automatic analysis nobody asked for adds its result without an undo step, and only to a
 *   song that still has no beats from this audio; edits and history stay.
 * - Otherwise an ordinary, undoable edit (a new analysis the operator asked for, a removed beat, a cleared result).
 * `source` is the audio the beats belong to (`songMusicAudio`): normally `songMusicSource(item)` when they were made,
 * or the song audio for beats from before 0.5.9. The command is refused when the song no longer has that audio.
 */
export function setSongMusicCommand(itemId: string, source: Pick<ReferenceAudioSource, 'sha256' | 'durationMs'>, input: SongMusic, options: { label: string; background?: boolean }): LinkCommand {
  const music = songMusicSchema.parse(input);
  const fingerprint = { sha256: source.sha256, durationMs: source.durationMs };
  if (music.sourceSha256 !== fingerprint.sha256 || Math.abs(music.sourceDurationMs - fingerprint.durationMs) > 50) throw new Error('音源或裁剪已改变，本次分析不能应用');
  const current = (project: LinkProject) => project.rundown.find(item => item.id === itemId);
  const matches = (project: LinkProject): boolean => {
    const item = current(project), audio = item && songMusicAudio(item, music);
    return audio?.sha256 === fingerprint.sha256 && audio.durationMs === fingerprint.durationMs;
  };
  const apply = (project: LinkProject, background: boolean): LinkProject => {
    const item = current(project);
    if (!item || !matches(project)) return project;
    if (background && item.music?.sourceSha256 === fingerprint.sha256) return project;
    return withSchemaVersion({ ...project, rundown: project.rundown.map(entry => entry === item ? { ...entry, music: structuredClone(music) } : entry) });
  };
  const execute = (project: LinkProject): LinkProject => {
    if (!matches(project)) throw new Error('音源或节目已改变，本次分析不能应用');
    return { ...apply(project, options.background === true), updatedAt: new Date().toISOString() };
  };
  // Beats never reach the outputs, so like a lighting edit they can be undone while a song plays.
  if (!options.background) return { id: crypto.randomUUID(), label: options.label, scope: 'lighting', execute, undo: before => before };
  return {
    id: crypto.randomUUID(), label: options.label, scope: 'lighting',
    historyRebaseKey: `music-analysis:${itemId}:${fingerprint.sha256}:${fingerprint.durationMs}`,
    rebaseHistory: project => apply(project, true),
    execute,
    undo: before => before
  };
}
