import { describe, it, expect } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { ibcProjectSchema, importIbcCommand } from './ibc-project';

describe('IBC 工程导入', () => {
  const source = () => ibcProjectSchema.parse({ playlist_manager: { playlists: [{ name: '第一轮', items: [{ file_path: 'D:\\music\\song.wav', duration: 20,
    start_time: 1, end_time: 18, mtc_offset: 60, shortcut_key: 'Ctrl+F2', obs_scene: '拉腿全景' }] }] } });
  const audio = [{ assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 20000 }];
  it('保留列表、裁剪、MTC、快捷键和初始完整场景，并可撤销', () => {
    const before = createEmptyLinkProject('接收');
    const command = importIbcCommand(source(), audio, before.timebase.frameRate);
    const result = command.execute(before);
    expect(result.obsOutputMode).toBe('scenes'); expect(result.rundown[0]?.playback).toMatchObject({ startMs: 1000, endMs: 18000, mtcOffsetMs: 60000, shortcut: 'Ctrl+F2' });
    expect(result.rundown[0]?.cues[0]?.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneName: '拉腿全景' });
    expect(result.playlists?.[0]?.id).toBe(result.rundown[0]?.playlistId); expect(command.undo(before)).toEqual(before); expect(before.rundown).toHaveLength(0);
  });
  it('无效裁剪、缺失素材和未知 MIDI 类型阻断导入', () => {
    const invalid = source(); invalid.playlist_manager.playlists[0]!.items[0]!.start_time = 19;
    expect(() => importIbcCommand(invalid, audio, '30').execute(createEmptyLinkProject('接收'))).toThrow();
    expect(() => importIbcCommand(source(), [], '30')).toThrow('素材导入不完整');
    expect(() => parseLinkProject({ ...createEmptyLinkProject('坏工程'), rundown: [{ id: 'x', title: 'x', referenceAudio: audio[0], playback: { volume: 100, endAction: 'next', startMs: 18000, endMs: 10000, mtcOffsetMs: 0, shortcut: '' } }] })).toThrow('裁剪范围');
  });
});
