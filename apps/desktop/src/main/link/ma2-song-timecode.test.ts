import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { MA2_SONG_TIMECODE_SLOT } from '@tb/core/link';
import { ma2SongTimecodeXml, writeMa2SongTimecode } from './ma2-song-timecode';
import { inspectMa2TimecodeXml, ma2TimecodeAfterCueReindex, validateMa2TimecodeWrite } from './ma2-timecode-xml';

const existing = readFileSync(new URL('./fixtures/ma2-timecode-onpc-3.7-100.xml', import.meta.url), 'utf8');
const song = { name: 'LianDongGeQu', startMs: 480000, executor: '1000.101', executorName: 'LianDongGeQu 1000.101', sequence: 9950,
  cues: [{ atMs: 0, cueIndex: 1, number: '1.000', name: 'KaiChang' }, { atMs: 1000.4, cueIndex: 2, number: '2.500', name: 'FuGe' }, { atMs: 61234, cueIndex: 3, number: '3.000', name: null }] };

it('在序列中间插 Cue 后按编号核对步号；同时移动过的触发点必须重新合并', async () => {
  const before = {number: song.sequence, name: song.name, cues: song.cues.map(cue => ({...cue, index: cue.cueIndex}))};
  const after = {...before, cues: before.cues.map(cue => ({...cue, index: cue.index === 1 ? 1 : cue.index + 1}))};
  const xml = ma2SongTimecodeXml(existing, 9907, song);
  const reindexed = ma2TimecodeAfterCueReindex(xml, before, after)!;
  const events = inspectMa2TimecodeXml(reindexed).timecodes[0]!.tracks[0]!.subtracks[0]!.events;
  expect(events.map(e => [e.attributes.step, e.cueAddress[2]])).toEqual([['1','1'],['3','3'],['4','4']]);
  const target = { ...song, previous: { number: 9907, offset: 14400, slot: MA2_SONG_TIMECODE_SLOT, revision: 'a'.repeat(64) },
    version: '3.7.0.5', lengthMs: undefined, created: vi.fn(), currentTimecode: {number: 9907, xml}, reindexedTimecode: reindexed };
  const executor = '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Exec offset_from_first="0" tblink_executor_name="Target"><Assignment name="Song"><No>25</No><No>1</No><No>9950</No></Assignment></Exec></MA>';
  const request = vi.fn().mockResolvedValueOnce(reindexed).mockResolvedValue(executor);
  const exchange = vi.fn().mockImplementation((_op: string, _n: number, expected: string, desired: string) => {
    expect(expected).toBe(reindexed);
    return Promise.resolve({ response: desired, requestId: 'a'.repeat(32) });
  });
  await writeMa2SongTimecode({request, exchange}, target);
  expect(exchange).toHaveBeenCalledTimes(1);
  request.mockReset().mockResolvedValue(reindexed.replace('time="30"', 'time="46"'));
  await expect(writeMa2SongTimecode({request, exchange}, target)).rejects.toThrow('控台同时在改');
  expect(exchange).toHaveBeenCalledTimes(1);
});

it('自有节目整份重建：起点为歌曲起始码，一条本曲执行器轨道，每个点位一个 Goto，时间取整到帧', () => {
  const xml = ma2SongTimecodeXml(existing, 9907, song);
  validateMa2TimecodeWrite(xml);
  const timecode = inspectMa2TimecodeXml(xml).timecodes[0]!;
  expect(timecode.index).toBe(9906);
  expect(timecode.attributes).toMatchObject({ name: 'LianDongGeQu', offset: '14400', slot: MA2_SONG_TIMECODE_SLOT, frame_format: '30 FPS' });
  expect(timecode.attributes.m_autostart).toBeUndefined();
  expect(timecode.attributes.no_status_call).toBeUndefined();
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
