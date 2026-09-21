import { afterEach, expect, it, vi } from 'vitest';
import { createLightingDocument, lightingTrackSchema } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../link/view-models/local-integration-profile';
import { LightingCueAudition } from './lighting-cue-audition';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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
  const pending = f.audition.play(f.document, 'a', f.profile); f.audition.cancel(); finish();
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
