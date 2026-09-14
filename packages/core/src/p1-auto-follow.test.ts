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
