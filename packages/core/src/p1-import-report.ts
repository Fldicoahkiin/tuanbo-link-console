import type { LinkProject, RundownItem } from '@tb/schema';
import { readSongMtcStart, type SongMtcStartReading } from './mtc-start';
import { programTimeOrigin } from './ma2-time-origin';
import { songLightingStatus } from './song-lighting-status';

export type P1ImportedSong = { itemId: string; title: string; start: SongMtcStartReading };
/**
 * A song added here (not from P1) with the same name as one song from P1 but another MTC start: its
 * console timeline, if one was recorded in the old P1 workflow, starts where the P1 song does.
 * `lit` says the local song already has console lighting of its own, whose timeline the start moves.
 */
export type P1SameNameSong = {
  localId: string; localTitle: string; localStart: SongMtcStartReading; lit: boolean;
  p1Id: string; p1Title: string; p1StartMs: number; durationDifferenceMs: number | null;
};

/** Titles compare without a file extension, surrounding spaces or letter case. */
const songName = (title: string): string => title.trim().replace(/\.[a-z0-9]{2,4}$/i, '').trim().toLocaleLowerCase();

/** The songs one P1 read brought in, with their MTC starts, and the local songs that look like them. */
export function p1ImportReport(project: LinkProject, sourceKeys: readonly string[]): { songs: P1ImportedSong[]; sameName: P1SameNameSong[] } {
  const keys = new Set(sourceKeys);
  const imported = project.rundown.filter(item => item.p1Media && keys.has(item.p1Media.sourceKey));
  const songs = imported.map(item => ({ itemId: item.id, title: item.title, start: readSongMtcStart(item) }));
  const named = (items: RundownItem[]): Map<string, RundownItem[]> => {
    const groups = new Map<string, RundownItem[]>();
    for (const item of items) { const name = songName(item.title); groups.set(name, [...groups.get(name) ?? [], item]); }
    return groups;
  };
  const p1ByName = named(project.rundown.filter(item => item.p1Media));
  const sameName: P1SameNameSong[] = [];
  for (const [name, locals] of named(project.rundown.filter(item => !item.p1Media && item.referenceAudio))) {
    const p1 = p1ByName.get(name);
    // Two songs of one name on either side cannot be told apart by name.
    if (locals.length !== 1 || p1?.length !== 1 || !keys.has(p1[0]!.p1Media!.sourceKey)) continue;
    const local = locals[0]!; const source = p1[0]!;
    const p1Start = readSongMtcStart(source);
    if (p1Start.state !== 'set') continue;
    const localStart = readSongMtcStart(local);
    if (localStart.state === 'set' && localStart.startMs === p1Start.startMs) continue;
    sameName.push({ localId: local.id, localTitle: local.title, localStart, lit: songLightingStatus(project, local.id).state !== 'unmatched',
      p1Id: source.id, p1Title: source.title, p1StartMs: p1Start.startMs,
      durationDifferenceMs: local.referenceAudio && source.referenceAudio ? Math.abs(local.referenceAudio.durationMs - source.referenceAudio.durationMs) : null });
  }
  return { songs, sameName };
}

/** The local song's playback with the P1 song's MTC start, for `setItemPlaybackCommand`. */
export function withP1MtcStart(local: RundownItem, p1StartMs: number): NonNullable<RundownItem['playback']> {
  return { ...local.playback ?? { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: programTimeOrigin(local), shortcut: '' }, mtcOffsetMs: p1StartMs };
}
