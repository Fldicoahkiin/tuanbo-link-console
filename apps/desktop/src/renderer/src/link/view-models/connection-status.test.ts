import { expect, it } from 'vitest';
import { obsConnectionStatus, midiConnectionStatus, ma2EditingConnectionStatus, lightingConnectionDestination } from './connection-status';

it('编辑灯光跟随实际连接，不依赖一键检查；断开后不沿用旧成功结果；文字和颜色一致', () => {
  const input = { method: 'network' as const, network: { state: 'connected' as const, error: null }, networkError: null, local: { status: 'disconnected' as const, error: null }, bridge: undefined };
  expect(ma2EditingConnectionStatus(input)).toMatchObject({ state: 'ready', value: '已连接' });
  expect(ma2EditingConnectionStatus({ ...input, network: { state: 'disconnected', error: null }, bridge: { state: 'ready', detail: '旧检查通过', checkedAt: 1 } })).toMatchObject({ state: 'idle', value: '未连接' });
  expect(ma2EditingConnectionStatus({ ...input, network: { state: 'authenticating', error: null } })).toMatchObject({ state: 'checking', value: '连接中' });
  expect(ma2EditingConnectionStatus({ ...input, networkError: '状态读取失败' })).toMatchObject({ state: 'error', value: '连接异常' });
  const bridgeFailure = ma2EditingConnectionStatus({ ...input, bridge: { state: 'error', detail: '读写检查失败', checkedAt: 1 } });
  expect(bridgeFailure).toMatchObject({ state: 'warning', value: '读写异常' });
  expect(bridgeFailure.detail).toContain('读写检查失败');
  expect(ma2EditingConnectionStatus({ ...input, method: 'local', local: { status: 'ready', error: null } })).toMatchObject({ state: 'ready', value: '已连接' });
  expect(ma2EditingConnectionStatus({ ...input, method: 'midi' })).toMatchObject({ state: 'skipped', value: '未启用' });
});

it('顶部视频只使用实际 OBS 连接，清单检查不能覆盖连接状态', () => {
  const base = { obsVersion: null, webSocketVersion: null, error: null };
  expect(obsConnectionStatus({ ...base, status: 'connected' })).toMatchObject({ state: 'ready', value: '已连接' });
  expect(obsConnectionStatus({ ...base, status: 'disconnected' })).toMatchObject({ state: 'idle', value: '未连接' });
  expect(obsConnectionStatus({ ...base, status: 'reconnecting' })).toMatchObject({ state: 'checking' });
});
it('Windows 独有 USB 接口可用时亮绿，不宣称控台已出灯；拔出则未连接', () => {
  const input = { required: true, portName: 'USB MIDI Interface', available: true, open: false, native: true, check: undefined, systemError: '浏览器未读取到 MIDI' };
  expect(midiConnectionStatus(input)).toMatchObject({ state: 'ready', value: '可用' });
  expect(midiConnectionStatus({ ...input, available: false })).toMatchObject({ state: 'error', value: '未连接' });
  expect(midiConnectionStatus({ ...input, check: { state: 'error', detail: '接口被占用', checkedAt: 1 } })).toMatchObject({ state: 'error', detail: '接口被占用' });
});
it('实际打开的浏览器端口不受旧检查失败覆盖，灯光跳转始终为时间码', () => {
  expect(midiConnectionStatus({ required: true, portName: 'USB MIDI Interface', available: true, open: true, native: false, check: { state: 'error', detail: '旧错误', checkedAt: 1 }, systemError: undefined })).toMatchObject({ state: 'ready', value: '已连接' });
  expect(lightingConnectionDestination).toEqual({ category: 'audio', focus: 'lighting-mtc' });
});
