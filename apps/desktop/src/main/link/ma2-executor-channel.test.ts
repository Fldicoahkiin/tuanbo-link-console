import { expect, it } from 'vitest';
import { Ma2ExecutorChannels, isMa2ButtonAreaSlot, webRemoteFromAnswer } from './ma2-executor-channel';

const scope = JSON.stringify([{ host: '192.0.2.1' }, { show: 'TEST', generation: '1', version: '3.3.4.3' }]);
const other = JSON.stringify([{ host: '192.0.2.2' }, { show: 'TEST', generation: '1', version: '3.3.4.3' }]);

it('控台的回答：读回了格号一致的 Button 执行器才算网页遥控能用；没有执行器、读不了都写明原因', () => {
  expect(webRemoteFromAnswer({ kind: 'slots', page: 1000, start: 116, count: 3 })).toEqual({ ready: true, reason: '网页遥控读回了第 1000 页 116–130 格的 3 个执行器，格号和请求的一致' });
  const empty = webRemoteFromAnswer({ kind: 'empty', page: 1, ranges: 6 });
  expect(empty.ready).toBe(false);
  expect(empty.reason).toContain('没有执行器');
  const failed = webRemoteFromAnswer({ kind: 'failed', page: 1000, start: 101, reason: '控台返回的 Button 区格号和请求的不一致' });
  expect(failed.ready).toBe(false);
  expect(failed.reason).toContain('网页遥控读不回第 1000 页 101–115 格：控台返回的 Button 区格号和请求的不一致');
});

it('默认走控台插件；选了网页遥控并且这台控台读回了才走网页遥控；推杆区和 191 以后总是插件', () => {
  const channels = new Ma2ExecutorChannels();
  expect(channels.buttons(scope)).toMatchObject({ kind: 'plugin', choice: 'plugin', webRemote: { ready: false } });
  // With the plugin chosen nothing was read, and that is said plainly, not as a warning.
  expect(channels.buttons(scope).webRemote.reason).toBe('选了网页遥控才会去读 Button 区');
  channels.decide(scope, { kind: 'slots', page: 1000, start: 101, count: 15 });
  expect(channels.forKey(scope, 101)).toBe('plugin');
  expect(channels.choose('webRemote')).toBe(true);
  expect(channels.choose('webRemote')).toBe(false);
  expect(channels.forKey(scope, 101)).toBe('webRemote');
  expect(channels.forKey(scope, 190)).toBe('webRemote');
  expect(channels.forKey(scope, 1)).toBe('plugin');
  expect(channels.forKey(scope, 90)).toBe('plugin');
  expect(channels.forKey(scope, 191)).toBe('plugin');
  // Chosen, but this console was not read: the plugin, saying the web remote is not connected.
  expect(channels.buttons(other)).toMatchObject({ kind: 'plugin', choice: 'webRemote' });
  expect(channels.buttons(other).reason).toContain('网页遥控没连上');
  expect([100, 101, 190, 191].map(isMa2ButtonAreaSlot)).toEqual([false, true, true, false]);
});

it('出错不换通道：错误记在原因里，只有重新连接网页遥控或操作员改选择时才变', () => {
  const channels = new Ma2ExecutorChannels();
  channels.choose('webRemote');
  channels.decide(scope, { kind: 'slots', page: 1000, start: 101, count: 2 });
  channels.failed(scope, '实时推杆读取超时，请重新连接');
  channels.failed(scope, '控台上这一格叫「A」，页面上是「B」');
  expect(channels.buttons(scope).kind).toBe('webRemote');
  expect(channels.buttons(scope).reason).toContain('控台上这一格叫「A」');
  expect(channels.buttons(scope).reason).toContain('通道不变');
  // An error on another console is not this console's.
  channels.failed(other, 'other');
  expect(channels.buttons(scope).reason).not.toContain('other');
  channels.decide(scope, { kind: 'failed', page: 1000, start: 101, reason: '控台用户没有执行器播放权限' });
  expect(channels.buttons(scope)).toMatchObject({ kind: 'plugin', choice: 'webRemote' });
  expect(channels.buttons(scope).reason).toContain('没有执行器播放权限');
  channels.failed(scope, '控台连接变了，按键没有发送');
  expect(channels.buttons(scope).kind).toBe('plugin');
  channels.choose('plugin');
  expect(channels.buttons(scope)).toMatchObject({ kind: 'plugin', choice: 'plugin' });
  // What was read is forgotten when the plugin is chosen: choosing the web remote again needs a new read.
  channels.forget(); channels.choose('webRemote');
  expect(channels.buttons(scope).reason).toContain('网页遥控没连上');
});
