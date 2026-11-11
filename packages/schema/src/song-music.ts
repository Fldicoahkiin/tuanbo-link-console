import { z } from 'zod';
import { musicStructureSchema } from './music-structure';

/**
 * A song's beats and sections, one per song, shared by the editor and the lighting workspace (schema 3, 0.5.9 E9).
 * Bound to the audio it was analysed from, in that audio's own time: normally the music track's source file, so
 * cutting, moving or padding the song's audio keeps it valid (packages/core/src/song-beats.ts projects it onto the
 * song). Data migrated from before 0.5.9 is bound to the rendered song audio it was analysed from then.
 */
export const songMusicSchema = z.object({
  version: z.literal(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDurationMs: z.number().finite().positive(),
  /** automatic: the music recognition (Beat This and all-in-one); ibt: the simple beat detection. */
  method: z.enum(['automatic', 'ibt']),
  structure: musicStructureSchema
}).strict().superRefine((music, ctx) => {
  if (music.structure.sourceSha256 !== music.sourceSha256 || music.structure.durationMs !== music.sourceDurationMs) {
    ctx.addIssue({ code: 'custom', message: '节拍记录的音频和识别结果对不上' });
  }
});
export type SongMusic = z.infer<typeof songMusicSchema>;
