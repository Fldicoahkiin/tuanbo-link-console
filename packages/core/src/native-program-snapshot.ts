import { programTimeOrigin } from './ma2-time-origin';
import { playbackSnapshotSchema, type LinkProject, type PlaybackSnapshot } from '@tb/schema';

/**
 * What the engine plays for a song. The timecode always starts from the song's own MTC start
 * (2026-10-26: the console runs whatever it holds; a pairing still to check, an edit not yet on the
 * console or a start that differs from the paired show is a warning of the start check, never a
 * reason to hold the timecode back). `allowMtc` is false only when no timecode can be sent at all.
 */
export function nativeProgramSnapshot(project: LinkProject, itemId: string, revision: number,
  positionMs: number | undefined, sampleRate: 44100 | 48000): { snapshot: PlaybackSnapshot; notice: string | null; allowMtc: boolean } {
  const item = project.rundown.find(candidate => candidate.id === itemId && candidate.enabled);
  if (!item?.referenceAudio) throw new Error('节目没有可播放的音频');
  const audio = item.referenceAudio;
  const startMs = item.playback?.startMs ?? 0;
  const endMs = item.playback?.endMs || audio.durationMs;
  const problems: string[] = [];
  let offsetMs = 0;
  try { offsetMs = programTimeOrigin(item); }
  catch (error) { problems.push(`${error instanceof Error ? error.message : String(error)}；这次不发时间码，请检查歌曲起始码。`); }
  if (!problems.length && offsetMs + endMs >= 86400000) problems.push('歌曲的时间码范围超过一天，这次不发时间码。');
  const rate = project.timebase.frameRate;
  // Audio-only preparation does not invent a replacement song timecode. The
  // native offset is unused when MIDI is disabled; authored data stays intact.
  const notice = problems.length ? problems.join('；') : null;
  const allowMtc = notice === null;
  const snapshot = playbackSnapshotSchema.parse({ version: 1, projectId: project.projectId, itemId, revision,
    audio: { relativePath: audio.relativePath, sha256: audio.sha256, durationMs: audio.durationMs },
    startMs, endMs, positionMs: positionMs ?? startMs, offsetMs: allowMtc ? offsetMs : 0,
    frameRate: rate === '24' ? 24 : rate === '25' ? 25 : rate === '29.97df' ? 29.97 : 30, sampleRate, volume: (item.playback?.volume ?? 100) / 100 });
  return { snapshot, notice, allowMtc };
}
