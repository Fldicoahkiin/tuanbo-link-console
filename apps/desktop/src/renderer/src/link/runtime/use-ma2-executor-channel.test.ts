import { expect, it, vi } from 'vitest';
import type { Ma2ExecutorChannel } from '@tb/schema';

const storage = vi.hoisted(() => new Map<string, string>());
vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }); });
vi.mock('../stores/ma2-layout-store', () => ({ ma2LayoutConnection: vi.fn() }));
const { chooseMa2KeyChannel, ma2KeyChannelLabel, syncMa2KeyChannel } = await import('./use-ma2-executor-channel');
const { useMa2KeyChannelPreference } = await import('./ma2-realtime-preference');

const ready = { ready: true, reason: '网页遥控读回了第 1000 页 101–115 格的 2 个执行器，格号和请求的一致' };
const missing = { ready: false, reason: '网页遥控没连上：灯光工作台推杆页还没“连接”' };
const channel = (value: Partial<Ma2ExecutorChannel>): { kind: 'channel'; channel: Ma2ExecutorChannel } => ({ kind: 'channel', channel: { kind: 'plugin', choice: 'plugin', reason: '选的是控台插件，和 0.5.8 一样', webRemote: ready, ...value } });

it('这台电脑没选过时是控台插件；改选择先告诉主进程再记住；每次启动先把选择告诉主进程一次', async () => {
  expect(useMa2KeyChannelPreference.getState().choice).toBe('plugin');
  const choose = vi.fn(() => Promise.resolve());
  vi.stubGlobal('window', { tbLink: { chooseMa2ExecutorChannel: choose } });
  await syncMa2KeyChannel(); await syncMa2KeyChannel();
  expect(choose.mock.calls).toEqual([[{ choice: 'plugin' }]]);
  await chooseMa2KeyChannel('webRemote');
  expect(choose).toHaveBeenLastCalledWith({ choice: 'webRemote' });
  expect(storage.get('tblink.ma2-key-channel.v1')).toBe('webRemote');
  expect(useMa2KeyChannelPreference.getState().choice).toBe('webRemote');
  choose.mockRejectedValueOnce(new Error('按键松开后没有得到控台确认'));
  await expect(chooseMa2KeyChannel('plugin')).rejects.toThrow('没有得到控台确认');
  expect(useMa2KeyChannelPreference.getState().choice).toBe('webRemote');
});

it('标签照实写：选了网页遥控但这次走插件时写明原因；191 以后一直写控台插件', () => {
  expect(ma2KeyChannelLabel(channel({ webRemote: { ready: false, reason: '选了网页遥控才会去读 Button 区' } }), 101)).toMatchObject({ text: '按键：控台插件', tone: 'normal' });
  expect(ma2KeyChannelLabel(channel({ kind: 'webRemote', choice: 'webRemote', reason: ready.reason }), 101).text).toBe('按键：网页遥控');
  expect(ma2KeyChannelLabel(channel({ kind: 'webRemote', choice: 'webRemote', reason: ready.reason }), 191).text).toBe('按键：控台插件');
  const fallback = ma2KeyChannelLabel(channel({ choice: 'webRemote', reason: missing.reason, webRemote: missing }), 101);
  expect(fallback).toMatchObject({ text: `按键：控台插件（${missing.reason}）`, tone: 'warning' });
  expect(ma2KeyChannelLabel({ kind: 'unknown', reason: '请先连接控台' }, 101)).toMatchObject({ text: '按键通道无法确认', title: '请先连接控台', tone: 'warning' });
});
