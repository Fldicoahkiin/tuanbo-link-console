import { expect, it } from 'vitest';
import { createEmptyLinkProject, linkCueSchema, type LinkProject } from '@tb/schema';
import { programStart } from './program-start';

function project(): LinkProject {
  const value = createEmptyLinkProject('开播');
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 10_000 },
    playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' } }];
  return value;
}
const options = { revision: 1, positionMs: undefined, sampleRate: 48_000 as const, mtcPortName: null, check: true };

it('没有灯光和画面工作的歌：发本曲起始码的时间码，画面只给一秒，没有提示', () => {
  expect(programStart(project(), 'song', options)).toMatchObject({ allowMtc: true, picture: 'optional', warnings: [], snapshot: { offsetMs: 480_000, positionMs: 0 } });
});

it('起始码无效时这首歌照常播放，只是不发时间码，提示写明原因且只写一次', () => {
  const value = project(); value.rundown[0]!.playback!.mtcOffsetMs = 86_395_000;
  const start = programStart(value, 'song', options);
  expect(start.allowMtc).toBe(false);
  expect(start.snapshot.offsetMs).toBe(0);
  expect(start.warnings).toEqual([expect.stringContaining('这次不发时间码')]);
});

it('要画面的歌等画面准备，失败也照常播放；同曲定位不再重复开播前检查', () => {
  const value = project();
  value.rundown[0]!.cues = [linkCueSchema.parse({ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: '场景' }] })];
  expect(programStart(value, 'song', { ...options, positionMs: 3000, check: false })).toMatchObject({ picture: 'wait', allowMtc: true, warnings: [], snapshot: { positionMs: 3000 } });
});

it('没有音频的歌没有东西可放，明确报错', () => {
  const value = project(); delete value.rundown[0]!.referenceAudio;
  expect(() => programStart(value, 'song', options)).toThrow('节目没有可播放的音频');
});
