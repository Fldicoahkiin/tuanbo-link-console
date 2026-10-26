import { expect, it } from 'vitest';
import { createLightingDocument, type LightingTrack } from '@tb/schema';
import { collectLightingOutputProfileIds, compileLightingPackets, compileLightingNetworkActions, compileLightingReleasePackets, lightingTimecodePlaybackNotice } from './lighting-playback';

function track(id: string, portProfileId: string): LightingTrack {
  return { id, name: id, kind: 'midi', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId, controller: 7, noteNames: {}, clips: [{ id: 'clip-' + id, name: id, start: 0, duration: 1000, timeLock: 'time', muted: false, events: [{ id: 'note-' + id, kind: 'note', at: 0, note: 60, velocity: 100, duration: 500 }] }] };
}
it('原生时间线切换模式与重新打开时允许检查端口，播放仍严格拒绝部分重放', () => {
  const document = createLightingDocument();
  document.tracks = [track('native', 'console')];
  document.ma2Bindings = [{ id: 'binding', name: '原生灯光', timecode: 2, readAt: new Date().toISOString(), sourceXml: '<MA/>', baselineTracks: [], mappings: [], nativeEvents: [{ path: 'unknown', reason: '保留原生参数' }], playback: 'native-timecode', timeOriginMs: 0 }];
  for (const mode of ['network', 'direct', 'timecode'] as const) {
    document.outputMode = mode;
    expect(collectLightingOutputProfileIds(document)).toEqual(mode === 'timecode' ? [] : ['console']);
    if (mode === 'timecode') expect(compileLightingPackets(document)).toEqual([]);
    else expect(() => compileLightingPackets(document)).toThrow('保持控台原样的时间线');
    if (mode === 'network') expect(() => compileLightingNetworkActions(document)).toThrow('保持控台原样的时间线');
    if (mode === 'direct') expect(() => compileLightingReleasePackets(document)).toThrow('保持控台原样的时间线');
  }
});
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
it('序列池 Cue 在时间码模式不阻断编排也不伪装成 MIDI 指令', () => {
  const document = createLightingDocument(); document.outputMode = 'timecode';
  const source = track('pool', '');
  source.clips[0]!.events = [{ id: 'cue', kind: 'ma2', at: 0, label: 'Cue 1', action: 'goto', sequence: 36, cue: '1.000', executor: '' }];
  document.tracks = [source];
  expect(compileLightingPackets(document)).toEqual([]);
  expect(lightingTimecodePlaybackNotice(document)).toContain('不会单独发送');
  document.tracks[0]!.muted = true;
  expect(lightingTimecodePlaybackNotice(document)).toBeNull();
});
it('状态栏读取连接需求不编码 Cue，待编排的不可发送动作不能使界面崩溃', () => {
  const document = createLightingDocument(); document.outputMode = 'direct';
  const source = track('unfinished', 'console');
  source.clips[0]!.events = [{ id: 'next', kind: 'ma2', at: 0, label: '下一步', action: 'go', executor: '1.101' }];
  document.tracks = [source];
  expect(() => compileLightingPackets(document)).toThrow('不支持');
  expect(collectLightingOutputProfileIds(document)).toEqual(['console']);
});
