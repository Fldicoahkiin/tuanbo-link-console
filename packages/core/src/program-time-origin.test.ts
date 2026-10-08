import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { programTimeOrigin } from './ma2-time-origin';
import { nativeProgramSnapshot } from './native-program-snapshot';
import { setItemPlaybackCommand } from './link-command';
import { matchMa2Programs } from './ma2-program-matching';

function fixture() {
  return parseLinkProject({ ...createEmptyLinkProject('P1 起点回归'), playbackSource: 'internal', obsOutputMode: 'scenes',
    p1Sync: { format: 'hirender-p1-audio-project', sourceSha256: 'b'.repeat(64), importedAt: new Date().toISOString(), playlists: [{ id: 'list', name: '列表', sourceIndex: 0 }] }, rundown: [{
    id: 'song', title: '与灯光不同的歌名', referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
    p1Media: { sourceKey: 'c'.repeat(64), playlistId: 'list', sourceFileName: 'song.wav', playEndAction: 'stop', volume: 100, muted: false, shortcut: '',
      midiStartTime: '120.5', sourceTrim: { startMs: 3500, endMs: 13500, applied: true } }
  }] });
}

it('旧工程只有 P1 起点时直接播放保留原值，源音频已裁剪不再次加裁剪量', () => {
  const project = fixture();
  const result = nativeProgramSnapshot(project, 'song', 1, 1250, 48000);
  expect(result.allowMtc).toBe(true);
  expect(result.snapshot).toMatchObject({ offsetMs: 120500, positionMs: 1250 });
  expect(result.snapshot.offsetMs + result.snapshot.positionMs).toBe(121750);
  expect(project.rundown[0]!.playback).toBeUndefined();
});

it('编辑起点经保存重开后，播放和配对使用修改值，P1 原始导入值仍保留', () => {
  const before = fixture();
  const command = setItemPlaybackCommand('song', { volume: 100, endAction: 'pause', startMs: 500, endMs: 0, mtcOffsetMs: 240000, shortcut: '' });
  const after = parseLinkProject(JSON.parse(JSON.stringify(command.execute(before))));
  expect(programTimeOrigin(after.rundown[0]!)).toBe(240000);
  expect(after.rundown[0]!.p1Media!.midiStartTime).toBe('120.5');
  expect(nativeProgramSnapshot(after, 'song', 2, undefined, 48000).snapshot).toMatchObject({ offsetMs: 240000, positionMs: 500 });
  expect(matchMa2Programs(after, { directory: { show: 'test', version: '3.7.0.5', generation: '1', entries: [] }, readAt: new Date().toISOString(), entries: [
    { target: 2, name: '另一名称', frameFormat: '30 FPS', offset: '7200', slot: 'TC Slot 2', eventCount: 1,
      events: [{ path: 'event', time: '30', action: 'Goto', executor: '51.101', cue: '1.100', name: '步骤' }], error: null, warnings: [] }
  ] }).pairs).toEqual({ 2: 'song' });
  expect(programTimeOrigin(command.undo(before).rundown[0]!)).toBe(120500);
});

it('明确编辑为零不会被非零 P1 原值替换', () => {
  const before = fixture();
  const after = setItemPlaybackCommand('song', { volume: 100, endAction: 'pause', startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' }).execute(before);
  expect(nativeProgramSnapshot(after, 'song', 1, undefined, 48000).snapshot.offsetMs).toBe(0);
});
