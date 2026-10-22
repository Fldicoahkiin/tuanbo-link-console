import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./license-output', () => ({ requireOutputLicense: vi.fn().mockResolvedValue(undefined) }));
import { createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../link/view-models/local-integration-profile';
import { LightingMidiOutput } from './lighting-midi-output';

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const document = createLightingDocument(); document.outputMode = 'direct';
  document.tracks = [lightingTrackSchema.parse({ id: 'cue', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '开场', start: 0, duration: 2000, timeLock: 'time', muted: false, events: [{ id: 'event', kind: 'ma2', action: 'goto', cue: '1.25', sequence: 1, executor: '2.101', label: '开场 Cue', at: 100 }] }] })];
  const profile = createDefaultIntegrationProfile();
  profile.midiPortProfiles = [{ id: 'lighting-events-output', direction: 'output', portName: 'USB MIDI' }];
  profile.lighting = { ...profile.lighting, mscDeviceId: 5 };
  const send = vi.fn(); const port = { name: 'USB MIDI', state: 'connected', open: () => Promise.resolve(), send };
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve({ outputs: new Map([['usb', port]]) }) });
  return { document, profile, send, output: new LightingMidiOutput() };
}

it('不连接控台网络，新建 Cue 使用配置的默认 MIDI 端口并发送真实 MSC 字节', async () => {
  const f = setup(); await f.output.prepare(f.document, f.profile, 0);
  f.output.tick(99); expect(f.send).not.toHaveBeenCalled();
  f.output.tick(100);
  expect(f.send).toHaveBeenCalledWith([0xf0, 0x7f, 5, 2, 1, 1, ...Array.from('1.250\0' + '101.2', value => value.charCodeAt(0)), 0xf7]);
  f.output.tick(101); expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.document.tracks[0]!.portProfileId).toBe('');
  f.output.stop();
});

it('指定独立端口断开时不改发默认端口，缺少默认配置也明确失败', async () => {
  const f = setup(); f.document.tracks[0]!.portProfileId = 'missing';
  await expect(f.output.prepare(f.document, f.profile, 0)).rejects.toThrow('不可用或不唯一');
  f.document.tracks[0]!.portProfileId = ''; f.profile.midiPortProfiles = [];
  await expect(f.output.prepare(f.document, f.profile, 0)).rejects.toThrow('不可用或不唯一');
  expect(f.send).not.toHaveBeenCalled();
});

it('控台时间线模式不重复发送 Cue', async () => {
  const f = setup(); f.document.outputMode = 'timecode';
  await f.output.prepare(f.document, f.profile, 0); f.output.tick(100);
  expect(f.send).not.toHaveBeenCalled();
});

it('本机播放按当前位置重建：继续时控台已在的 Cue 不重发，定位与位置更新中断只补差异并标红；跟随 P1 不重建', async () => {
  const f = setup(); const output = new LightingMidiOutput(true);
  const cues = () => f.send.mock.calls.map(call => (call[0] as number[])[5]);
  await output.prepare(f.document, f.profile, 0); output.tick(50); output.tick(100); expect(cues()).toEqual([1]);
  output.stop(); await output.prepare(f.document, f.profile, 120); output.tick(130);
  expect(cues()).toEqual([1]); expect(output.takeFault()).toBeNull();
  output.stop(); await output.prepare(f.document, f.profile, 50);
  expect(cues()).toEqual([1, 0x0b]); expect(output.takeFault()).toBe('灯光按播放位置重建：发送 1 条，中间事件不补发');
  output.tick(60); output.tick(300);
  expect(cues()).toEqual([1, 0x0b, 1]); expect(output.takeFault()).toBe('灯光位置更新中断 240ms：按当前位置重建，发送 1 条，中间事件不补发');
  output.stop(); f.send.mockClear();
  await f.output.prepare(f.document, f.profile, 50); f.output.tick(300); expect(cues()).toEqual([1]); expect(f.output.takeFault()).toBeNull();
  f.output.stop();
});
