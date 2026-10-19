import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Ma2LiveConnect, type Ma2LiveSnapshot } from '@tb/schema';
import { Ma2LiveService } from './ma2-live-service';

const mock = vi.hoisted(() => ({ input: vi.fn(), close: vi.fn(), read: vi.fn(), connect: vi.fn() }));
vi.mock('./ma2-live-playback', () => ({ Ma2LivePlayback: class {
  connected = true; input = mock.input; close = mock.close; read = mock.read; connect = mock.connect;
} }));
const source = { show: 'test', generation: 'one', version: '3.7.0.5' };
const request: Ma2LiveConnect = { network: { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'administrator' }, expectedSource: source, username: 'test', password: 'test-secret', page: 1000, start: 1 };
const readRequest = { network: request.network, expectedSource: source, page: 1000, start: 1 };
const snapshot = (): Ma2LiveSnapshot => ({ page: 1000, start: 1, readAt: Date.now(), items: [{ slot: 1, width: 1, name: 'test', objectType: 'LT', objectNumber: '9900', running: false, cue: '', blocks: [{ slot: 1, fader: { value: 1, min: 0, max: 1, name: 'LTP', text: '100%' }, buttons: [{ id: 0, name: 'Flash', active: false }] }] }] });
beforeEach(() => { vi.clearAllMocks(); mock.connect.mockResolvedValue(undefined); mock.read.mockImplementation(() => Promise.resolve(snapshot())); });
afterEach(() => vi.useRealTimers());
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'tblink-fader-test-'));
  const secrets = { saveCredential: vi.fn<(_key: string, value: string) => Promise<void>>().mockResolvedValue(undefined), loadCredential: vi.fn().mockResolvedValue('test-secret') };
  const bridge = { request: vi.fn().mockResolvedValue(JSON.stringify({ ...source, buttonPage: 1, faderPage: 1000, pages: [] })) };
  const service = new Ma2LiveService(join(dir, 'profiles.json'), secrets, () => bridge);
  await service.connect(request);
  return { service, secrets, bridge };
}
it('checks source, saves credentials separately and refuses empty, stale and unrelated targets', async () => {
  const { service, secrets } = await setup();
  try {
    expect(secrets.saveCredential).toHaveBeenCalledWith(expect.stringMatching(/^ma2-web-/), 'test-secret');
    service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 0.5 } });
    expect(mock.input).toHaveBeenCalledWith(1000, 1, { kind: 'fader', value: 0.5 });
    expect(() => service.input({ ...readRequest, slot: 2, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 0.5 } })).toThrow('没有可操作');
    expect(() => service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() - 1, action: { kind: 'fader', value: 0.5 } })).toThrow('过期');
    await expect(service.read({ ...readRequest, expectedSource: { ...source, generation: 'other' } })).rejects.toThrow('已改变');
  } finally { service.close(); }
});
it('releases held buttons once on blur, page change or shutdown; duplicate release cannot retrigger', async () => {
  const { service } = await setup();
  try {
    const input = { ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'button' as const, id: 0, pressed: true } };
    service.input(input); service.release(); service.release();
    service.input({ ...input, action: { ...input.action, pressed: false } });
    expect(mock.input.mock.calls).toEqual([[1000, 1, { kind: 'button', id: 0, pressed: true }], [1000, 1, { kind: 'button', id: 0, pressed: false }]]);
  } finally { service.close(); }
});
it('a missing renderer heartbeat releases a held button and blocks later writes without replay', async () => {
  const { service } = await setup(); vi.useFakeTimers();
  try {
    service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'button', id: 0, pressed: true } });
    await vi.advanceTimersByTimeAsync(1501);
    expect(mock.input).toHaveBeenLastCalledWith(1000, 1, { kind: 'button', id: 0, pressed: false });
    await expect(service.read(readRequest)).rejects.toThrow('已停止');
    expect(mock.connect).toHaveBeenCalledTimes(1);
  } finally { service.close(); }
});
it('source change during polling stops the live connection instead of showing old values', async () => {
  const { service, bridge } = await setup(); vi.useFakeTimers();
  try {
    bridge.request.mockResolvedValue(JSON.stringify({ ...source, show: 'other', buttonPage: 1, faderPage: 1000, pages: [] }));
    await vi.advanceTimersByTimeAsync(1001);
    await expect(service.read(readRequest)).rejects.toThrow('Show');
    expect(mock.close).toHaveBeenCalled();
  } finally { service.close(); }
});
it('disconnect while loading saved credentials cannot reopen an obsolete session', async () => {
  const { service, secrets } = await setup();
  service.close();
  let complete: (password: string) => void = () => { throw new Error('credential read has not started'); };
  let started: () => void = () => { throw new Error('test wait has not started'); };
  const loading = new Promise<void>(resolve => { started = resolve; });
  secrets.loadCredential.mockImplementation(() => new Promise<string>(resolve => { complete = resolve; started(); }));
  const reading = service.read(readRequest);
  const rejected = expect(reading).rejects.toThrow('已改变');
  await loading; service.close(); complete('test-secret');
  await rejected;
  expect(mock.connect).toHaveBeenCalledTimes(1);
});
it('uses the reported fader range for speed and special masters instead of assuming a dimmer percentage', async () => {
  const { service } = await setup();
  try {
    const speed = snapshot(); speed.items[0]!.blocks[0]!.fader = { value: 120, min: 0, max: 240, name: 'Speed', text: '120 BPM' };
    mock.read.mockResolvedValue(speed);
    await service.read(readRequest);
    service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 150 } });
    expect(mock.input).toHaveBeenLastCalledWith(1000, 1, { kind: 'fader', value: 150 });
    expect(() => service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 241 } })).toThrow('超出');
  } finally { service.close(); }
});
