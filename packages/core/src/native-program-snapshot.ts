import { lightingTimeOrigin, programTimeOrigin } from './ma2-time-origin';
import { playbackSnapshotSchema, type LinkProject, type PlaybackSnapshot } from '@tb/schema';

export function nativeProgramSnapshot(project: LinkProject, itemId: string, revision: number,
  positionMs: number | undefined, sampleRate: 44100 | 48000): { snapshot: PlaybackSnapshot; notice: string | null; allowMtc: boolean; allowLighting: boolean } {
  const item = project.rundown.find(candidate => candidate.id === itemId && candidate.enabled);
  if (!item?.referenceAudio) throw new Error('节目没有可播放的音频');
  const audio = item.referenceAudio;
  const startMs = item.playback?.startMs ?? 0;
  let offsetMs = 0;
  let notice: string | null = null;
  try {
    offsetMs = programTimeOrigin(item);
    const origin = lightingTimeOrigin(item.lighting, offsetMs);
    if ((item.playback || item.p1Media) && offsetMs !== origin) throw new Error('歌曲起点和 MA2 绑定的时间码对不上');
    offsetMs = origin;
  } catch (error) { notice = `${error instanceof Error ? error.message : String(error)}；这次不发时间码，请检查原始偏移。`; }
  const endMs = item.playback?.endMs || audio.durationMs;
  if (offsetMs + endMs >= 86400000) notice = '歌曲的时间码范围超过一天，这次不发时间码。';
  const stale = Object.values(project.ma2ReadState?.pairings ?? {}).some(pair => pair.itemId === itemId && pair.status === 'stale');
  // Playback only sends timecode (2026-10-23); the stored output mode does not open another route.
  const allowLighting = !stale;
  if (stale) notice = '这首歌还没和控台时间线确认关联，这次不发时间码，音频照常播放。请在控台时间线里确认关联。';
  const rate = project.timebase.frameRate;
  if (rate === '29.97df') notice = [notice, 'Windows 原生播放的 29.97df 时间码还没验证过，这次不发时间码。'].filter(Boolean).join('；');
  // Audio-only preparation does not invent a replacement song timecode. The
  // native offset is unused when MIDI is disabled; authored data stays intact.
  const allowMtc = notice === null && !stale;
  const snapshot = playbackSnapshotSchema.parse({ version: 1, projectId: project.projectId, itemId, revision,
    audio: { relativePath: audio.relativePath, sha256: audio.sha256, durationMs: audio.durationMs },
    startMs, endMs, positionMs: positionMs ?? startMs, offsetMs: allowMtc ? offsetMs : 0,
    frameRate: rate === '24' ? 24 : rate === '25' ? 25 : 30, sampleRate, volume: (item.playback?.volume ?? 100) / 100 });
  return { snapshot, notice, allowMtc, allowLighting };
}
