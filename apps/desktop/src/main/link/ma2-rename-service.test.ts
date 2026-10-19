import { expect, it, vi } from 'vitest';
import type { Ma2RenameRequest } from '@tb/schema';
import { renameMa2Object } from './ma2-rename-service';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';

const request: Ma2RenameRequest = { dataDirectory: '', network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, generation: 'session',
  change: { endpoint: '192.0.2.1:30000', show: '测试', sequence: 2, cue: '1.100', kind: 'single', confirmedName: 'Old', name: '面光' } };
const result = { sequence: 2, cue: '1.100', kind: 'single', show: '测试', generation: 'session', name: '面光', backupFile: `tblink_label_${'a'.repeat(32)}.xml` };
it('恢复原本未命名对象时明确阻断旧协议不支持的清空，不发送或冒充确认', async () => {
  const bridge = { request: vi.fn() };
  await expect(renameMa2Object(bridge, { ...request, change: { ...request.change, name: '' } })).rejects.toThrow('本次撤销尚未同步');
  expect(bridge.request).not.toHaveBeenCalled();
});
it('只发送类型化目标和 UTF-8 十六进制名称，并核对实际回读', async () => {
  const bridge = { request: vi.fn(() => Promise.resolve(JSON.stringify(result))) };
  expect(await renameMa2Object(bridge, request)).toEqual(result);
  expect(bridge.request).toHaveBeenCalledWith('LABEL', 2, ['single', '1.100', ...['测试', 'session', 'Old', '面光'].map(value => Buffer.from(value).toString('hex'))].join('\n'));
  await expect(renameMa2Object(bridge, { ...request, change: { ...request.change, endpoint: 'another' } })).rejects.toThrow('另一控台');
  bridge.request.mockResolvedValue(JSON.stringify({ ...result, name: 'Other' }));
  await expect(renameMa2Object(bridge, request)).rejects.toThrow('回读');
});
it('排队期间开始播放，改名不会发送；响应身份错误会阻断', async () => {
  let playing = false;
  const wire = { exchange: vi.fn((_id: string, _op: string, _target: number, _body: string, beforeSend: () => void) => { playing = true; beforeSend(); return Promise.resolve(JSON.stringify(result)); }) };
  const bridge = new Ma2OnpcBridge(wire, () => playing);
  await expect(renameMa2Object(bridge, request)).rejects.toThrow('播放已开始');
  playing = false;
  wire.exchange.mockImplementation(() => Promise.resolve(JSON.stringify({ ...result, sequence: 3 })));
  await expect(renameMa2Object(bridge, request)).rejects.toThrow('序列不一致');
});

it('控台拒绝中文与控台被另行改名分别提示，不要求新旧名称相同', async () => {
  const bridge = { request: vi.fn(() => Promise.reject(new Error('Name readback differs'))) };
  await expect(renameMa2Object(bridge, request)).rejects.toThrow('请使用英文或数字');
  bridge.request.mockRejectedValue(new Error('Console name changed'));
  await expect(renameMa2Object(bridge, request)).rejects.toThrow('新名称可以与原名不同');
});
