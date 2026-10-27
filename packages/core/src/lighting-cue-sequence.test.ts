import { describe, expect, it } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { createFixedLightingCueStamp, nextLightingCue, nextLightingMaster } from './lighting-cue-sequence';

function fixture() {
  const document = createLightingDocument();
  const track: LightingTrack = { id: 'track', kind: 'ma2', name: '灯光', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 10000, timeLock: 'time', muted: false, events: [] }] };
  document.tracks = [track];
  document.ma2Bindings = [{ id: 'binding', timecode: 1, name: '测试', readAt: '2026-09-11T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: structuredClone(document.tracks), mappings: [], trackMappings: [{ trackId: 'track', path: 'Track:0', executor: '99.219', subtracks: ['SubTrack:0'] }], cueCatalog: [{ sequence: 9901, name: null, cues: [{ index: 2, number: '7.500', name: '副歌' }, { index: 1, number: '1.250', name: null }] }] }];
  return { document, track, clip: track.clips[0]! };
}
describe('按真实 Cue 顺序打点', () => {
  it('主推杆复用明确绑定和前一推杆值，不消耗 Cue 或误取另一执行器', () => {
    const { document, track, clip } = fixture();
    expect(nextLightingMaster(document, track, 0)).toEqual({ executor: '99.219', level: 1, fader: 'Master', label: '主推杆' });
    clip.events = [
      { id: 'later', at: 2000, kind: 'ma2-fader', level: 0.1, executor: '99.219', fader: 'Master', label: '' },
      { id: 'earlier', at: 500, kind: 'ma2-fader', level: 0.625, executor: '99.219', fader: 'Master', label: '' },
      { id: 'other', at: 700, kind: 'ma2-fader', level: 0.8, executor: '99.218', fader: 'Master', label: '' }
    ];
    expect(nextLightingMaster(document, track, 1000)).toMatchObject({ executor: '99.219', level: 0.625 });
    expect(nextLightingCue(document, track, 1000).cue).toBe('1.250');
    track.cueStamp = { mode: 'marker' };
    expect(nextLightingMaster(document, track, 1000).level).toBe(0.625);
    document.ma2Bindings![0]!.trackMappings = [];
    expect(() => nextLightingMaster(document, track, 1000)).toThrow('还没绑定');
    document.ma2Bindings = [];
    expect(nextLightingMaster(document, track, 0).executor).toBe('1.1');
    expect(() => nextLightingMaster(document, track, Number.NaN)).toThrow('有效');
  });
  it('空绑定轨道的固定模式使用真实执行器和首个小数 Cue，支持待同步轨道', () => {
    const { document, track } = fixture();
    const expected = { mode: 'fixed', cue: '1.250', sequence: 9901, executor: '99.219' };
    expect(createFixedLightingCueStamp(document, track)).toEqual(expected);
    const binding = document.ma2Bindings![0]!;
    binding.baselineTracks = [];
    binding.pendingTracks = [{ trackId: track.id, executor: '99.219', executorName: '执行器' }];
    track.cueStamp = { mode: 'marker' };
    expect(createFixedLightingCueStamp(document, track)).toEqual(expected);
    delete binding.cueCatalog;
    expect(() => createFixedLightingCueStamp(document, track)).toThrow('指定序列');
    expect(track.cueStamp).toEqual({ mode: 'marker' });
    document.ma2Bindings = [];
    expect(createFixedLightingCueStamp(document, track)).toEqual({ mode: 'fixed', cue: '1', sequence: 1, executor: '' });
  });
  it('已有 Cue 按音乐位置选择，不受片段或数组顺序影响', () => {
    const { document, track, clip } = fixture();
    clip.events = [
      { id: 'later', at: 2000, kind: 'ma2', action: 'goto', cue: '7.500', sequence: 9901, executor: '99.219', label: '' },
      { id: 'first', at: 1000, kind: 'ma2', action: 'goto', cue: '1.250', sequence: 9901, executor: '99.219', label: '' }
    ];
    expect(createFixedLightingCueStamp(document, track).cue).toBe('1.250');
    expect(clip.events.map((event) => event.id)).toEqual(['later', 'first']);
  });
  it('固定 Cue 在正式和待同步绑定中均不能绕过执行器检查，离线轨道仍可打点', () => {
    const { document, track, clip } = fixture();
    track.cueStamp = { mode: 'fixed', sequence: 9901, cue: '7.500', executor: '1.1' };
    expect(() => nextLightingCue(document, track, 1000)).toThrow('改成 99.219');
    const binding = document.ma2Bindings![0]!;
    binding.baselineTracks = [];
    binding.pendingTracks = [{ trackId: track.id, executor: '99.218', executorName: '待同步' }];
    expect(() => nextLightingCue(document, track, 1000)).toThrow('改成 99.218');
    track.cueStamp.executor = '99.218';
    expect(nextLightingCue(document, track, 1000).executor).toBe('99.218');
    expect(clip.events).toEqual([]);
    document.ma2Bindings = [];
    track.cueStamp.executor = '1.1';
    expect(nextLightingCue(document, track, 1000).executor).toBe('1.1');
  });
  it('固定打点重复指定 Cue，切回顺序模式不改变已有点', () => {
    const { document, track, clip } = fixture();
    track.cueStamp = { mode: 'fixed', sequence: 9901, cue: '7.500', executor: '99.219' };
    for (const ms of [1000, 2000]) {
      const cue = nextLightingCue(document, track, ms);
      expect(cue).toMatchObject({ cue: '7.500', sequence: 9901, executor: '99.219' });
      clip.events.push({ id: String(ms), at: ms, kind: 'ma2', action: 'goto', ...cue });
    }
    track.cueStamp = { mode: 'sequence' };
    expect(() => nextLightingCue(document, track, 3000)).toThrow('全部打完');
    expect(clip.events).toHaveLength(2);
  });
  it('空轨道从第一项开始，小数和跳号按控台顺序，结束不猜测下一编号', () => {
    const { document, track, clip } = fixture();
    expect(nextLightingCue(document, track, 0)).toMatchObject({ cue: '1.250', sequence: 9901, executor: '99.219' });
    clip.events.push({ id: 'first', at: 1000, kind: 'ma2', action: 'goto', ...nextLightingCue(document, track, 1000) });
    expect(nextLightingCue(document, track, 2000)).toMatchObject({ cue: '7.500', label: '副歌' });
    clip.events.push({ id: 'second', at: 2000, kind: 'ma2', action: 'goto', ...nextLightingCue(document, track, 2000) });
    expect(() => nextLightingCue(document, track, 3000)).toThrow('全部打完');
    expect(nextLightingCue(document, track, 500).cue).toBe('1.250');
  });
  it('拖动或跨片段编辑后按播放位置选择前一项，Go/Off 不影响编号', () => {
    const { document, track, clip } = fixture();
    clip.timeLock = 'beat'; clip.start = 2;
    clip.events = [{ id: 'later', at: 2, kind: 'ma2', cue: '7.500', sequence: 9901, executor: '99.219', action: 'goto', label: '副歌' }, { id: 'earlier', at: 0, kind: 'ma2', cue: '1.250', sequence: 9901, executor: '99.219', action: 'goto', label: '前奏' }, { id: 'off', at: 1, kind: 'ma2', executor: '99.219', action: 'off', label: '关闭' }];
    expect(nextLightingCue(document, track, 1500).cue).toBe('7.500');
    expect(() => nextLightingCue(document, track, 2500)).toThrow('全部打完');
  });
  it('缺失列表、Cue 被移除或多序列不明确时拒绝猜测', () => {
    const { document, track, clip } = fixture();
    clip.events.push({ id: 'first', at: 0, kind: 'ma2', action: 'goto', cue: '2', sequence: 9901, executor: '99.219', label: '不存在' });
    expect(() => nextLightingCue(document, track, 1000)).toThrow('列表中没有');
    delete document.ma2Bindings![0]!.cueCatalog;
    expect(() => nextLightingCue(document, track, 1000)).toThrow('还没读取');
    clip.events = [];
    expect(() => nextLightingCue(document, track, 1000)).toThrow('指定序列');
  });
});
