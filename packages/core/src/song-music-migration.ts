import { songMusicSchema, type LinkProject, type RundownItem, type SongMusic } from '@tb/schema';
import { ibtSongMusic } from './music-structure';
import { withSchemaVersion } from './project-schema-version';

type OldBeats = NonNullable<NonNullable<RundownItem['referenceAudio']>['beats']>;
/** A song that had both kinds of old beats: the music recognition's were kept; these simple detection beats were not
 * kept in the project and go to the log instead. */
export type DroppedSongBeats = { itemId: string; title: string; beats: OldBeats };
export type SongMusicMigration = { project: LinkProject; moved: number; dropped: DroppedSongBeats[] };

/**
 * Opening a project from before 0.5.9 (E9): each song's old beats move to `rundownItem.music`, the only copy since.
 * - `lighting.musicAnalysis` (the music recognition) moves as it is, bound to the audio it was analysed from.
 * - Otherwise `referenceAudio.beats` (the simple detection) becomes an `ibt` result with every beat it found;
 *   its strong beats are those of its sparsest level.
 * - A song with both keeps the music recognition's; the other is returned in `dropped`, for the log.
 * Both old fields are then removed and the project needs schema 3. A project with no old beats is returned as it is,
 * the same object, so its version and its "unchanged" state stay. Only this opening step calls it.
 */
export function migrateSongMusic(project: LinkProject): SongMusicMigration {
  const dropped: DroppedSongBeats[] = [];
  let moved = 0;
  const rundown = project.rundown.map(item => {
    const analysis = item.lighting?.musicAnalysis, oldBeats = item.referenceAudio?.beats;
    if (!analysis && !oldBeats) return item;
    const next: RundownItem = { ...item };
    if (item.lighting && analysis) {
      const lighting = { ...item.lighting };
      delete lighting.musicAnalysis;
      next.lighting = lighting;
    }
    if (item.referenceAudio && oldBeats) {
      const referenceAudio = { ...item.referenceAudio };
      delete referenceAudio.beats;
      next.referenceAudio = referenceAudio;
    }
    // A schema 3 file cannot hold the old fields with `music` (the schema refuses it), so nothing here is overwritten.
    if (item.music) throw new Error(`「${item.title}」的节拍存了两份，没有打开`);
    let music: SongMusic;
    if (analysis) {
      music = songMusicSchema.parse({ version: 1, sourceSha256: analysis.sourceSha256, sourceDurationMs: analysis.durationMs, method: 'automatic', structure: analysis });
      if (oldBeats) dropped.push({ itemId: item.id, title: item.title, beats: oldBeats });
    } else {
      const beats = oldBeats!;
      const points = beats.levels?.dense ?? beats.pointsMs;
      music = ibtSongMusic({ sha256: beats.sourceSha256, durationMs: item.referenceAudio!.durationMs }, { dense: points, sparse: beats.levels?.sparse ?? points.filter((_, index) => index % 4 === 0) }, 'migrated-ibt');
    }
    next.music = music;
    moved++;
    return next;
  });
  return moved ? { project: withSchemaVersion({ ...project, rundown }), moved, dropped } : { project, moved, dropped };
}

/** The project with every song's beats in `rundownItem.music` (see `migrateSongMusic`). */
export function withSongMusic(project: LinkProject): LinkProject {
  return migrateSongMusic(project).project;
}
