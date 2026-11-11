import type { RundownItem } from '@tb/schema';

export type ResolvedReferenceAudioUrl = { projectPath: string; relativePath: string; sha256: string; url: string };

/** A link is used only for the song it was asked for. Until the new song's link arrives the old one
 * stays unused: 2026-11-11 the home player paired the previous song's link with the next song's
 * audio, the waveform of the wrong file was saved under the new song and stopped part way. */
export function matchedReferenceAudioUrl(resolved: ResolvedReferenceAudioUrl | null, projectPath: string | null,
  audio: Pick<NonNullable<RundownItem['referenceAudio']>, 'relativePath' | 'sha256'> | undefined): string | null {
  return resolved && audio && resolved.projectPath === projectPath && resolved.relativePath === audio.relativePath && resolved.sha256 === audio.sha256 ? resolved.url : null;
}
