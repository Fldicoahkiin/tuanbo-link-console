import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./license-output', () => ({ requireOutputLicense: vi.fn().mockResolvedValue(undefined) }));
import { createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../link/view-models/local-integration-profile';
import { LightingCueAudition } from './lighting-cue-audition';
import { compileLightingNetworkActions } from '@tb/core/link';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function networkFixture() {
  const f = fixture();
  f.document.ma2Bindings = [{ id: 'native', timecode: 2, name: 'mei-nan', readAt: '2026-09-26T00:00:00Z', sourceXml: '<Timecode><unknown/></Timecode>', baselineTracks: structuredClone(f.document.tracks), mappings: [], playback: 'native-timecode', nativeEvents: [{ path: 'unknown', reason: 'Learn' }] }];
  const play = vi.fn(() => Promise.resolve());
  const status = vi.fn(() => Promise.resolve({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, version: '3.7.0.5', passwordSaved: false, error: null }));
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: status, playMa2Cue: play, cancelMa2Playback: vi.fn(() => Promise.resolve()) } });
  return { ...f, play, status };
}

it('多步序列发送 Go 和 Off 原命令，不根据缓存列表猜测下一 Cue 或自动补发', async () => {
  const f = networkFixture();
  expect(await f.audition.playAction({ target: 'sequence', sequence: 36, action: 'go' })).toBe(true);
  expect(f.play).toHaveBeenLastCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 36, action: 'go' } }));
  expect(await f.audition.playAction({ target: 'executor', executor: '51.101', action: 'off' })).toBe(true);
  expect(f.play).toHaveBeenLastCalledWith(expect.objectContaining({ action: { target: 'executor', executor: '51.101', action: 'off' } }));
  expect(f.play).toHaveBeenCalledTimes(2); expect(f.request).not.toHaveBeenCalled();
});

it('原生混合时间线只试听指定序列 Cue，原文和完整播放限制保持不变', async () => {
  const f = networkFixture(); const before = structuredClone(f.document);
  expect(await f.audition.play(f.document, 'b', f.profile)).toBe(1);
  expect(f.play).toHaveBeenCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 1, cue: '2', action: 'goto' } }));
  expect(f.play).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
  expect(f.document).toEqual(before);
  expect(() => compileLightingNetworkActions({ ...f.document, outputMode: 'network' })).toThrow('原生保留');
});

it('未放进时间线的素材点击也调用原序列 Cue，不插入事件或更改输出模式', async () => {
  const f = networkFixture();
  f.document.templates = [{ id: 'material', name: '原控台名称', track: { ...f.document.tracks[0]!, cueStamp: { mode: 'fixed', sequence: 36, cue: '1.100', executor: '51.101' } } }];
  const before = structuredClone(f.document);
  expect(await f.audition.playTemplate(f.document, 'material', f.profile)).toBe(1);
  expect(f.play).toHaveBeenCalledWith(expect.objectContaining({ action: { target: 'sequence', sequence: 36, cue: '1.100', action: 'goto' } }));
  expect(f.document).toEqual(before);
});

it('Cue 网络调用失败直接返回原因，不自动重发或改走 MIDI', async () => {
  const f = networkFixture(); f.play.mockRejectedValue(new Error('控台没有找到 Sequence 1 Cue 2'));
  await expect(f.audition.play(f.document, 'b', f.profile)).rejects.toThrow('控台没有找到');
  expect(f.play).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
});
function fixture() {
  const document = createLightingDocument();
  document.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 1000, duration: 5000, timeLock: 'time', muted: false, events: [{ id: 'a', kind: 'ma2', action: 'goto', cue: '1', sequence: 1, executor: '2.101', label: 'A', at: 2000 }, { id: 'b', kind: 'ma2', action: 'goto', cue: '2', sequence: 1, executor: '2.101', label: 'B', at: 4000 }] }] })];
  const profile = createDefaultIntegrationProfile(); profile.midiPortProfiles.push({ id: 'lighting-events-output', direction: 'output', portName: 'USB' });
  const send = vi.fn(); const open = vi.fn(() => Promise.resolve());
  const access = { outputs: new Map([['usb', { name: 'USB', state: 'connected', open, send }]]) };
  const request = vi.fn(() => Promise.resolve(access)); vi.stubGlobal('navigator', { requestMIDIAccess: request });
  return { document, profile, send, open, request, access, audition: new LightingCueAudition() };
}
it('选中 Cue 即发送该 Cue，不启动音乐、不发送其他点、不要求网络或直控模式', async () => {
  const f = fixture();
  expect(await f.audition.play(f.document, 'b', f.profile)).toBe(1);
  expect(f.send).toHaveBeenCalledWith([0xf0, 0x7f, 127, 2, 1, 1, ...Array.from('2.000\0' + '101.2', char => char.charCodeAt(0)), 0xf7]);
  expect(f.send).toHaveBeenCalledTimes(1); expect(f.document.outputMode).toBe('timecode');
});
it('快速改选时迟到的前一条 Cue 不得发送', async () => {
  const f = fixture(); let finish = (): void => { throw new Error('未开始'); };
  f.open.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = f.audition.play(f.document, 'a', f.profile);
  await vi.waitFor(() => expect(f.open).toHaveBeenCalledOnce());
  await f.audition.play(f.document, 'b', f.profile); finish();
  expect(await first).toBe(0); expect(f.send).toHaveBeenCalledTimes(1);
});
it('关闭选中即播放后，正在申请权限的 Cue 不得补发', async () => {
  const f = fixture(); let finish = (): void => { throw new Error('未开始'); };
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(f.access); }));
  const pending = f.audition.play(f.document, 'a', f.profile);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce());
  f.audition.cancel(); finish();
  expect(await pending).toBe(0); expect(f.send).not.toHaveBeenCalled();
});
it('权限挂起明确超时，不会在超时后补发', async () => {
  vi.useFakeTimers(); const f = fixture();
  let finish = (): void => { throw new Error('未开始'); };
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(f.access); }));
  const rejected = expect(f.audition.play(f.document, 'a', f.profile)).rejects.toThrow('MIDI 访问超时');
  await vi.advanceTimersByTimeAsync(5000); await rejected; finish(); await Promise.resolve();
  expect(f.send).not.toHaveBeenCalled();
});
