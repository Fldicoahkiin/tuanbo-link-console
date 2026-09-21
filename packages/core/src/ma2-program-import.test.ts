import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { importMa2ProgramsCommand } from './ma2-program-import';
const preview = (target: number): Ma2TimecodePreview => ({ target, name: '控台灯光', document: createLightingDocument(), sourceXml: '<MA/>', readAt: '2026-09-15T00:00:00.000Z', mappings: [], warnings: [], unconverted: [] });
it('多节目原子导入、一次撤销、重复导入拒绝并保留原工程', () => {
  const before = createEmptyLinkProject('现场');
  before.rundown = ['a', 'b'].map(id => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [] }));
  const command = importMa2ProgramsCommand([{ itemId: 'a', preview: preview(1) }, { itemId: 'b', preview: preview(2) }]);
  const after = command.execute(before);
  expect(after.rundown.map(item => item.lighting?.ma2Bindings?.[0]?.timecode)).toEqual([1, 2]);
  expect(before.rundown.every(item => !item.lighting)).toBe(true);
  expect(command.undo(before)).toEqual(before);
  expect(() => command.execute(after)).toThrow('重复');
  expect(() => importMa2ProgramsCommand([{ itemId: 'a', preview: preview(1) }, { itemId: 'missing', preview: preview(2) }]).execute(before)).toThrow('不存在');
  expect(before.rundown.every(item => !item.lighting)).toBe(true);
});
it('保留 P1 起点原格式，并接通非零播放时间码', () => {
  const before = createEmptyLinkProject('现场');
  before.p1Sync = { format: 'hirender-p1-audio-project', sourceSha256: 'a'.repeat(64), importedAt: '2026-09-15T00:00:00.000Z', playlists: [{ id: 'playlist', name: '现场', sourceIndex: 0 }] };
  before.rundown = [{ id: 'a', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], p1Media: { sourceKey: 'b'.repeat(64), playlistId: 'playlist', sourceFileName: 'song.wav', playEndAction: 'stop', volume: 100, muted: false, shortcut: '', midiStartTime: '00:00:00.000' } }];
  const command = importMa2ProgramsCommand([{ itemId: 'a', preview: preview(1) }]);
  expect(command.execute(before).rundown[0]?.p1Media?.midiStartTime).toBe('00:00:00.000');
  before.rundown[0]!.p1Media!.midiStartTime = '00:01:00';
  const imported = command.execute(before);
  expect(imported.rundown[0]?.playback?.mtcOffsetMs).toBe(60000);
  expect(imported.rundown[0]?.lighting?.ma2Bindings?.[0]?.timeOriginMs).toBe(60000);
  expect(before.rundown[0]?.lighting).toBeUndefined();
  expect(before.rundown[0]?.p1Media?.midiStartTime).toBe('00:01:00');
});
