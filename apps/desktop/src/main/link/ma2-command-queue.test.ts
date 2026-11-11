import { expect, it } from 'vitest';
import { Ma2CommandQueue, type Ma2QueueWait } from './ma2-command-queue';
import { ma2CommandKind } from './ma2-telnet';

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

it('排着 3 条普通命令时关灯先发', async () => {
  const queue = new Ma2CommandQueue(); const order: string[] = [];
  let finish: (value: string) => void = () => { throw new Error('not started'); };
  const blocker = queue.schedule(() => new Promise(resolve => { finish = resolve; }), 'normal', 'plugin:chunk');
  const normals = [1, 2, 3].map(index => queue.schedule(() => { order.push(`normal ${index}`); return Promise.resolve(''); }, 'normal'));
  const off = queue.schedule(() => { order.push('off'); return Promise.resolve(''); }, 'stop', 'cue');
  finish('');
  await Promise.all([blocker, ...normals, off]);
  expect(order).toEqual(['off', 'normal 1', 'normal 2', 'normal 3']);
});

it('正在执行的普通命令不被打断，关灯紧跟其后；记下等了多久和前面在跑什么', async () => {
  let now = 1000;
  const queue = new Ma2CommandQueue(() => now); const order: string[] = [];
  let finish: (value: string) => void = () => { throw new Error('not started'); };
  const run = queue.schedule(() => new Promise(resolve => { order.push('run start'); finish = value => { order.push('run end'); resolve(value); }; }), 'normal', 'plugin:run');
  const next = queue.schedule(() => { order.push('next read'); return Promise.resolve(''); }, 'normal', 'plugin:read');
  now = 1200;
  let wait: Ma2QueueWait | null = null;
  const off = queue.schedule(queued => { wait = queued; order.push('off'); return Promise.resolve('SENT'); }, 'stop', 'cue');
  await new Promise(resolve => setImmediate(resolve));
  // The plugin step already on the line answers first: a Telnet command cannot be taken back.
  expect(order).toEqual(['run start']);
  now = 4700; finish('DONE:1');
  await expect(off).resolves.toBe('SENT');
  await Promise.all([run, next]);
  expect(order).toEqual(['run start', 'run end', 'off', 'next read']);
  expect(wait).toEqual({ waitedMs: 3500, runningKind: 'plugin:run', sentBefore: 0 });
});

it('线路空闲时关灯不用等，前面没有命令', async () => {
  const queue = new Ma2CommandQueue(() => 50);
  let wait: Ma2QueueWait | null = null;
  await queue.schedule(queued => { wait = queued; return Promise.resolve(''); }, 'stop', 'cue');
  expect(wait).toEqual({ waitedMs: 0, runningKind: null, sentBefore: 0 });
});

it('命令种类按插件动作和短命令区分，只用于日志', () => {
  expect(ma2CommandKind("Lua \"if TBLINK_NET then TBLINK_NET('ab12','run','cd34') else gma.echo('x') end\"")).toBe('plugin:run');
  expect(ma2CommandKind("Lua \"if TBLINK_NET then TBLINK_NET('ab12','begin','cd34','SYNC',3,10) else gma.echo('x') end\"")).toBe('plugin:begin');
  expect(ma2CommandKind("Lua \"for i=0,3 do TBLINK_NET('ab12'..string.format('%04x',i),'read','cd34',0+i*256) end\"")).toBe('plugin:read');
  expect(ma2CommandKind("Lua \"gma.cmd('Off Executor 1.101');gma.echo('TBLINK_PLAY_ab:SENT')\"")).toBe('cue');
  expect(ma2CommandKind('Login "a" "b"')).toBe('login');
  expect(ma2CommandKind("Lua \"gma.echo('TBLINK_SHOWCHECK_ab:H')\"")).toBe('show-check');
  expect(ma2CommandKind("Lua \"gma.echo('x')\"")).toBe('lua');
});
