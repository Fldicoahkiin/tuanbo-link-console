import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MA2_SONG_TIMECODE_SLOT } from '@tb/core/link';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { inspectMa2TimecodeXml, validateMa2TimecodeWrite } from './ma2-timecode-xml';

const existing = readFileSync(new URL('./fixtures/ma2-timecode-onpc-3.7-100.xml', import.meta.url), 'utf8');
const song = { name: 'LianDongGeQu', startMs: 480000, executor: '1000.101', executorName: 'LianDongGeQu 1000.101', sequence: 9950,
  cues: [{ atMs: 0, cueIndex: 1, number: '1.000', name: 'KaiChang' }, { atMs: 1000.4, cueIndex: 2, number: '2.500', name: 'FuGe' }, { atMs: 61234, cueIndex: 3, number: '3.000', name: null }] };

it('自有节目整份重建：起点为歌曲起始码，一条本曲执行器轨道，每个点位一个 Goto，时间取整到帧', () => {
  const xml = ma2SongTimecodeXml(existing, 9907, song);
  validateMa2TimecodeWrite(xml);
  const timecode = inspectMa2TimecodeXml(xml).timecodes[0]!;
  expect(timecode.index).toBe(9906);
  expect(timecode.attributes).toMatchObject({ name: 'LianDongGeQu', offset: '14400', slot: MA2_SONG_TIMECODE_SLOT, frame_format: '30 FPS', m_autostart: 'true' });
  expect(timecode.tracks).toHaveLength(1);
  expect(timecode.tracks[0]!.executorAddress).toEqual(['30', '1', '1000', '101']);
  const events = timecode.tracks[0]!.subtracks[0]!.events;
  expect(events.map(event => event.attributes.time ?? '0')).toEqual(['0', '30', '1837']);
  expect(events.map(event => event.cueAddress)).toEqual([['1', '9950', '1'], ['1', '9950', '2'], ['1', '9950', '3']]);
  // Stored as the console keeps it: "<label> <number>", or "Cue <number>" without a label.
  expect(events.map(event => event.cueName)).toEqual(['KaiChang 1', 'FuGe 2.5', 'Cue 3']);
  expect(Number(timecode.attributes.lenght)).toBeGreaterThan(1837);
});

it('给出歌曲时长时节目长度覆盖整首歌，其他工程分配起点时看到整首都已占用；最后点位更晚时仍以点位为准', () => {
  expect(inspectMa2TimecodeXml(ma2SongTimecodeXml(existing, 9907, { ...song, lengthMs: 240_000 })).timecodes[0]!.attributes.lenght).toBe('7200');
  expect(inspectMa2TimecodeXml(ma2SongTimecodeXml(existing, 9907, { ...song, lengthMs: 30_000 })).timecodes[0]!.attributes.lenght).toBe('1838');
});

it('起点为 0 时不写 offset；空歌曲只留轨道不留事件', () => {
  const xml = ma2SongTimecodeXml(existing, 9907, { ...song, startMs: 0, cues: [] });
  const timecode = inspectMa2TimecodeXml(xml).timecodes[0]!;
  expect(timecode.attributes.offset).toBeUndefined();
  expect(timecode.tracks[0]!.subtracks[0]!.events).toEqual([]);
  expect(() => ma2SongTimecodeXml(existing, 9908, song)).toThrow('写入目标不一致');
});
