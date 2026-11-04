import { expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, type LightingTrack } from '@tb/schema';
import { compileLightingPackets, compileLightingNetworkActions } from './lighting-playback';

function track(id: string, portProfileId: string): LightingTrack {
  return { id, name: id, kind: 'midi', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId, controller: 7, noteNames: {}, clips: [{ id: 'clip-' + id, name: id, start: 0, duration: 1000, timeLock: 'time', muted: false, events: [{ id: 'note-' + id, kind: 'note', at: 0, note: 60, velocity: 100, duration: 500 }] }] };
}
it('2026-11-01 只留时间码：旧工程存的直接 MIDI 和网络播放方式打开时都变成时间码，存回去也是时间码', () => {
  for (const outputMode of ['direct', 'network', 'timecode']) {
    const parsed = lightingDocumentSchema.parse({ ...createLightingDocument(), outputMode });
    expect(parsed.outputMode).toBe('timecode');
    expect(JSON.parse(JSON.stringify(parsed)).outputMode).toBe('timecode');
  }
  expect(() => lightingDocumentSchema.parse({ ...createLightingDocument(), outputMode: 'osc' })).toThrow();
});
it('保持控台原样的时间线不能用本地的部分事件代替，试听和导出都拒绝', () => {
  const document = createLightingDocument();
  document.tracks = [track('native', 'console')];
  document.ma2Bindings = [{ id: 'binding', name: '原生灯光', timecode: 2, readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], nativeEvents: [{ path: 'unknown', reason: '保留原生参数' }], playback: 'native-timecode', timeOriginMs: 0 }];
  expect(() => compileLightingPackets(document)).toThrow('保持控台原样的时间线');
  expect(() => compileLightingNetworkActions(document)).toThrow('保持控台原样的时间线');
});
it('MIDI 编码按独奏和静音取轨道，没选端口的轨道用默认灯光端口', () => {
  const document = createLightingDocument();
  document.tracks = [track('one', ''), track('two', 'custom'), { ...track('muted', 'unused'), muted: true }];
  expect(new Set(compileLightingPackets(document).map(packet => packet.portProfileId))).toEqual(new Set(['lighting-events-output', 'custom']));
  document.tracks[1]!.solo = true;
  expect(new Set(compileLightingPackets(document).map(packet => packet.portProfileId))).toEqual(new Set(['custom']));
});
it('MIDI 发不了序列池 Cue 和“播放控台下一步”，明确报错', () => {
  const document = createLightingDocument();
  const source = track('pool', 'console');
  source.clips[0]!.events = [{ id: 'cue', kind: 'ma2', at: 0, label: 'Cue 1', action: 'goto', sequence: 36, cue: '1.000', executor: '' }];
  document.tracks = [source];
  expect(() => compileLightingPackets(document)).toThrow('没有绑定执行器');
  source.clips[0]!.events = [{ id: 'next', kind: 'ma2', at: 0, label: '下一步', action: 'go', executor: '1.101' }];
  expect(() => compileLightingPackets(document)).toThrow('MIDI 发不了');
});
