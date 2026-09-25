import { expect, it } from 'vitest';
import { Ma2OnpcBridge, type Ma2Wire } from './ma2-onpc-bridge';

it('目录扫描与素材读取共享连接时，完整交换不交叉且不拒绝正常请求', async () => {
  const sent: number[] = [];
  let active = 0;
  const wire: Ma2Wire = { exchange: async (_id, _operation, target) => {
    active += 1; expect(active).toBe(1); sent.push(target);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1; return '3.3.4.3';
  } };
  const bridge = new Ma2OnpcBridge(wire, () => false);
  expect(await Promise.all([bridge.request('PING', 1), bridge.request('PING', 2), bridge.request('PING', 3)])).toEqual(['3.3.4.3', '3.3.4.3', '3.3.4.3']);
  expect(sent).toEqual([1, 2, 3]);
});
it('当前交换失败会取消后续请求，不发送和不重试', async () => {
  const sent: number[] = [];
  const wire: Ma2Wire = { exchange: (_id, _operation, target) => { sent.push(target); return Promise.reject(new Error('连接已断开')); } };
  const bridge = new Ma2OnpcBridge(wire, () => false);
  const result = await Promise.allSettled([bridge.request('PING', 1), bridge.request('PING', 2)]);
  expect(result.every(value => value.status === 'rejected')).toBe(true);
  expect(sent).toEqual([1]);
});
