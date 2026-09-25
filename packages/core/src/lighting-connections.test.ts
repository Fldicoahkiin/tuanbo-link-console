import { expect, it } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { collectLightingOutputProfileIds, compileLightingPackets } from './lighting-playback';

function track(id: string, portProfileId: string): LightingTrack {
  return { id, name: id, kind: 'midi', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId, controller: 7, noteNames: {}, clips: [{ id: 'clip-' + id, name: id, start: 0, duration: 1000, timeLock: 'time', muted: false, events: [{ id: 'note-' + id, kind: 'note', at: 0, note: 60, velocity: 100, duration: 500 }] }] };
}
it('端口检查与实际输出采用相同的独奏和静音规则，并识别默认灯光端口', () => {
  const document = createLightingDocument(); document.outputMode = 'direct';
  document.tracks = [track('one', ''), track('two', 'custom'), { ...track('muted', 'unused'), muted: true }];
  expect(collectLightingOutputProfileIds(document)).toEqual(['lighting-events-output', 'custom']);
  expect(new Set(collectLightingOutputProfileIds(document))).toEqual(new Set(compileLightingPackets(document).map(packet => packet.portProfileId)));
  document.tracks[1]!.solo = true;
  expect(collectLightingOutputProfileIds(document)).toEqual(['custom']);
  document.outputMode = 'timecode';
  expect(collectLightingOutputProfileIds(document)).toEqual([]);
});
it('状态栏读取连接需求不编码 Cue，待编排的不可发送动作不能使界面崩溃', () => {
  const document = createLightingDocument(); document.outputMode = 'direct';
  const source = track('unfinished', 'console');
  source.clips[0]!.events = [{ id: 'next', kind: 'ma2', at: 0, label: '下一步', action: 'go', executor: '1.101' }];
  document.tracks = [source];
  expect(() => compileLightingPackets(document)).toThrow('不支持');
  expect(collectLightingOutputProfileIds(document)).toEqual(['console']);
});
