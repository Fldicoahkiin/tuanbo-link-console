import { expect, it } from 'vitest';
import { Ma2CommandQueue } from './ma2-command-queue';

it('停止和现场点击先于待执行的读取，保留已发送请求的应答，不重发播放', async () => {
  const queue = new Ma2CommandQueue(); const order: string[] = [];
  let finish: (value: string) => void = () => { throw new Error('not started'); };
  const first = queue.schedule(() => new Promise(resolve => { order.push('inflight'); finish = resolve; }), 'normal');
  const read = queue.schedule(() => { order.push('read'); return Promise.resolve('read'); }, 'normal');
  const click = queue.schedule(() => { order.push('click'); return Promise.resolve('click'); }, 'playback');
  const stop = queue.schedule(() => { order.push('stop'); return Promise.resolve('stop'); }, 'stop');
  expect(order).toEqual(['inflight']); finish('done');
  await Promise.all([first, read, click, stop]);
  expect(order).toEqual(['inflight', 'stop', 'click', 'read']);
});
