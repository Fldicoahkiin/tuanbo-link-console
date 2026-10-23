import { createHash } from 'node:crypto';
import { ma2ObjectDirectorySchema } from '@tb/schema';
import { appendMa2Tracks } from './ma2-track-write';
import { createMa2TimecodeXml } from './ma2-create';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { extendMa2TimecodeLength, inspectMa2ExecutorXml, inspectMa2TimecodeXml, prepareMa2TimecodeEvents, resetMa2TimecodeShow, sameMa2XmlObjects } from './ma2-timecode-xml';

/** MIDI timecode reaches TC Slot 2 by default on grandMA2; the program's own shows listen there. */
export const MA2_SONG_TIMECODE_SLOT = 'TC Slot 2';

/** 30 FPS frames, the resolution of a grandMA2 Timecode show. */
const frames = (ms: number): number => Math.round(ms * 30 / 1000);

/**
 * The complete Timecode show that plays one song from its console Sequence: one track on the song's
 * executor and one Goto per point. The show starts at the song's MTC start, so points keep their
 * song-relative time; both are rounded to whole frames. Cue step indices must come from the
 * Sequence as the console holds it after the write, since Import and Copy renumber them.
 */
export function ma2SongTimecodeXml(currentXml: string, target: number, song: {
  name: string; startMs: number; executor: string; executorName: string; sequence: number;
  cues: ReadonlyArray<{ atMs: number; cueIndex: number; number: string; name: string | null }>;
}): string {
  const empty = resetMa2TimecodeShow(currentXml, target, { name: song.name, offset: frames(song.startMs), slot: MA2_SONG_TIMECODE_SLOT });
  const track = appendMa2Tracks(empty, target, [{ executor: song.executor, executorName: song.executorName, muted: false }]);
  const subtrackPath = `${track.paths[0]!}/SubTrack:0`;
  const events = prepareMa2TimecodeEvents(track.xml, inspectMa2TimecodeXml(track.xml).sha256, target, song.cues.map(cue => ({
    // The console stores a Cue reference as "<label> <number>" (onPC 3.7 probe), as Timecode event writes do.
    kind: 'add' as const, subtrackPath, rawTime: String(frames(cue.atMs)), cue: { sequence: song.sequence, cueIndex: cue.cueIndex, name: cue.name === null ? `Cue ${Number(cue.number)}` : `${cue.name} ${Number(cue.number)}` }
  })));
  return extendMa2TimecodeLength(events.xml, target);
}

export type Ma2SongTimecode = { number: number; offset: number; slot: string; revision: string };
const revision = (xml: string): string => createHash('sha256').update(xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim()).digest('hex');

/**
 * Writes the song's own Timecode show after its Sequence was verified. A show recorded earlier is
 * rebuilt only while the console still holds it exactly as last written, so edits made on the
 * console are never overwritten; a missing one is created again, a new one takes the first free
 * number from the song's Sequence number up. APPLY keeps a console backup before it imports.
 */
export async function writeMa2SongTimecode(bridge: Pick<Ma2OnpcBridge, 'request' | 'exchange'>, song: {
  previous: Ma2SongTimecode | undefined; sequence: number; executor: string; startMs: number; name: string; version: string;
  cues: ReadonlyArray<{ atMs: number; cueIndex: number; number: string; name: string | null }>;
}): Promise<{ timecode: Ma2SongTimecode; backup: string | null }> {
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  const taken = (target: number): boolean => directory.entries.some(entry => entry.target === target);
  let number = song.previous?.number;
  let current: string;
  if (number !== undefined && taken(number)) {
    current = await bridge.request('READ', number);
    if (revision(current) !== song.previous!.revision) throw new Error(`控台上的本曲时间码节目 Timecode ${number} 在上次同步后被改过，未覆盖；请在控台核对后重新同步`);
  } else {
    if (number === undefined) { number = song.sequence; while (taken(number) && number < 99999) number += 1; }
    if (taken(number)) throw new Error('从本曲序列号往后没有空的 Timecode 编号');
    current = await bridge.request('CREATE', number, '', createMa2TimecodeXml(number, song.name, song.version));
  }
  const [page, slot] = song.executor.split('.');
  const executorName = inspectMa2ExecutorXml(await bridge.request('EXECUTOR', Number(page), slot)).executorName;
  if (!executorName) throw new Error(`执行器 ${song.executor} 的名称未能读取，未写入时间码节目`);
  const desired = ma2SongTimecodeXml(current, number, { name: song.name, startMs: song.startMs, executor: song.executor, executorName, sequence: song.sequence, cues: song.cues });
  const timecode = (xml: string): Ma2SongTimecode => ({ number, offset: frames(song.startMs), slot: MA2_SONG_TIMECODE_SLOT, revision: revision(xml) });
  if (sameMa2XmlObjects(desired, current)) return { timecode: timecode(current), backup: null };
  const written = await bridge.exchange('APPLY', number, current, desired);
  return { timecode: timecode(written.response), backup: `tblink_backup_${written.requestId}` };
}
