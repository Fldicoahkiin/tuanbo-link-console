import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { allocateP1TimecodeRanges, locateP1Sample, validateP1TimecodeRanges } from './p1-auto-follow';
import { frameNumberToTimecode, type MtcSample } from './mtc-timecode';

export function followProject() {
  const project = parseLinkProject({ ...createEmptyLinkProject('自动跟随'), rundown: ['a', 'b'].map((id) => ({
    id, title: id, referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs: 30_000 }, cues: []
  })) });
  project.p1AutoFollow = allocateP1TimecodeRanges(project);
  return project;
}

export function p1Sample(seconds: number, at = performance.now()): MtcSample {
  const totalFrames = Math.round(seconds * 30);
  return { totalFrames, frameRate: '30', direction: 'forward', receivedAtMs: at, timecode: frameNumberToTimecode(totalFrames, '30') };
}

describe('P1 原生时间码映射', () => {
  it('确定区间、保留本地零点且隔离歌曲间隙', () => {
    const project = followProject();
    expect(project.p1AutoFollow?.ranges.map((range) => range.startSeconds)).toEqual([60, 100]);
    expect(locateP1Sample(project, p1Sample(101.2))).toMatchObject({ itemId: 'b', sample: { totalFrames: 36 } });
    expect(locateP1Sample(project, p1Sample(95))).toBeNull();
    expect(locateP1Sample(project, p1Sample(0))).toBeNull();
  });
  it('变更音频时长后拒绝沿用旧映射', () => {
    const project = followProject();
    project.rundown[0]!.referenceAudio!.durationMs = 40_000;
    expect(() => validateP1TimecodeRanges(project)).toThrow('过期');
  });
  it('拒绝重叠、未映射新增曲目和未验证的小时范围', () => {
    const project = followProject();
    project.p1AutoFollow!.ranges[1]!.startSeconds = 70;
    expect(() => validateP1TimecodeRanges(project)).toThrow('重叠');
    project.rundown[0]!.referenceAudio!.durationMs = 54_000_000;
    expect(() => allocateP1TimecodeRanges(project)).toThrow('15 小时');
  });
});

describe('P1 点歌区间沿用歌曲已有的 MTC 起始码', () => {
  const song = (id: string, startSeconds: number | null) => ({
    id, title: id, cues: [],
    referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs: 30_000 },
    ...startSeconds === null ? {} : { playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: startSeconds * 1000, shortcut: '' } }
  });
  it('已有起点的歌不动，没有起点的排在所有歌后面', () => {
    const project = parseLinkProject({ ...createEmptyLinkProject('沿用起点'), rundown: [song('a', 2400), song('b', null), song('c', 600)] });
    expect(allocateP1TimecodeRanges(project).ranges.map((range) => [range.itemId, range.startSeconds])).toEqual([['a', 2400], ['b', 2440], ['c', 600]]);
  });
  it('没有灯光的歌起点不能用时重新分配；有控台灯光的歌说明原因，不替它换起点', () => {
    const free = parseLinkProject({ ...createEmptyLinkProject('重叠'), rundown: [song('a', 2400), song('b', 2410)] });
    expect(allocateP1TimecodeRanges(free).ranges.map((range) => range.startSeconds)).toEqual([2400, 2440]);
    const lit = parseLinkProject({ ...createEmptyLinkProject('重叠'), rundown: [song('a', 2400), song('b', 2410)] });
    lit.schemaVersion = 2;
    lit.ma2ReadState = { source: 'console', pairs: {}, failures: [], selectedTarget: null, query: '', filter: 'all', message: '',
      catalog: { directory: { show: '测试 Show', generation: 'session', version: '3.3.4.3', entries: [{ target: 29, name: 'b' }] }, readAt: '2026-10-27T00:00:00.000Z',
        entries: [{ target: 29, name: 'b', eventCount: 1, frameFormat: '30 FPS', offset: '72300', slot: 'TC Slot 2', events: [{ path: '1', time: '30', action: 'Goto', executor: '1.1', cue: '1', name: null }], error: null, warnings: [] }] } };
    expect(() => allocateP1TimecodeRanges(lit)).toThrow(/「b」的 MTC 起始码不能用于 P1 点歌：和另一首歌的时间码范围重叠/);
  });
});
