import { expect, it, vi } from 'vitest';
import { OBS_RECONNECT_DELAYS_MS, OUTPUT_RECOVERY_RULES, type LinkObsSnapshot, type ObsAutoReconnect } from '@tb/core/link';
import { ObsReconnector, type ObsReconnectLog } from './obs-reconnector';

const snapshot = (status: LinkObsSnapshot['status'], error: string | null = null): LinkObsSnapshot => ({ status, obsVersion: null, webSocketVersion: null, error });
const flush = async (): Promise<void> => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

/** A reconnector on a fake clock. `connect` answers with what `results` holds next (true: connected). */
function setup() {
  let now = 0;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  const results: (boolean | Promise<boolean>)[] = [], states: (ObsAutoReconnect | null)[] = [], logs: ObsReconnectLog[] = [], waits: number[] = [];
  const connect = vi.fn(async (): Promise<LinkObsSnapshot> => {
    const next = await (results.shift() ?? false);
    if (!next) throw new Error('OBS WebSocket 连接失败：拒绝连接');
    return snapshot('connected');
  });
  const reconnector = new ObsReconnector({ connect, now: () => now, log: entry => logs.push(entry), changed: state => states.push(state),
    schedule: (ms, run) => { waits.push(ms); const timer = { at: now + ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } });
  /** Moves the clock on, running each timer that comes due. */
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter(timer => !timer.cancelled && timer.at <= until).sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      now = due.at; due.cancelled = true; due.run(); await flush();
    }
    now = until;
  };
  const connected = async (): Promise<void> => { results.push(true); await reconnector.manual(connect); };
  return { reconnector, connect, results, states, logs, waits, advance, connected, drop: (error = 'OBS 连接已关闭') => reconnector.observe(snapshot('disconnected', error)) };
}

const max = OUTPUT_RECOVERY_RULES['obs.reconnect'].limit.max;

it('操作员连上过的 OBS 自己断了：按 output-recovery.ts 的 1、2、4、8 秒，之后每 15 秒重连，最多 10 次；每次记一条带第几次和上限的日志（R7）', async () => {
  const test = setup(); await test.connected(); test.connect.mockClear();
  test.drop();
  expect(test.reconnector.state).toEqual({ state: 'waiting', attempt: 1, max });
  await test.advance(999); expect(test.connect).not.toHaveBeenCalled();
  await test.advance(1); expect(test.connect).toHaveBeenCalledOnce();
  await test.advance(5 * 60_000);
  expect(test.connect).toHaveBeenCalledTimes(max);
  expect(test.waits).toEqual([...OBS_RECONNECT_DELAYS_MS]);
  expect(test.reconnector.state).toEqual({ state: 'gave-up', attempts: max, max, text: 'OBS 自动重连没成功，请检查 OBS 后点连接' });
  const tries = test.logs.filter(entry => entry.level === 'warning');
  expect(tries.map(entry => entry.message)).toEqual(Array.from({ length: max }, (_, index) => `OBS 断开了，正在自动重连（第 ${index + 1} 次，最多 10 次）`));
  expect(tries[0]!.details).toEqual({ channel: 'obs', item: 'obs.reconnect', attempt: 1, max: 10, reason: 'OBS 连接已关闭', recoveries: [{ row: 'obs.reconnect', key: 'obs', count: 1, max: 10 }] });
  expect(tries[1]!.details.reason).toBe('OBS WebSocket 连接失败：拒绝连接');
  expect(test.logs.at(-1)).toMatchObject({ level: 'error', result: 'failed', message: 'OBS 自动重连没成功，请检查 OBS 后点连接（自动重连了 10 次）' });
  // At the limit it waits for the operator: nothing more by itself.
  test.drop(); await test.advance(60_000); expect(test.connect).toHaveBeenCalledTimes(max);
});

it('自动重连连上了：状态收回，下次再断从第 1 次重新数', async () => {
  const test = setup(); await test.connected(); test.connect.mockClear();
  test.drop(); test.results.push(false, true);
  await test.advance(3000);
  expect(test.connect).toHaveBeenCalledTimes(2); expect(test.reconnector.state).toBeNull();
  expect(test.logs.at(-1)).toMatchObject({ level: 'info', message: 'OBS 已自动重新连上（第 2 次）' });
  test.drop(); expect(test.reconnector.state).toEqual({ state: 'waiting', attempt: 1, max });
});

it('没有手动连上过、或者操作员自己点了断开：OBS 断了不自动重连', async () => {
  const never = setup(); never.drop(); await never.advance(60_000);
  expect(never.connect).not.toHaveBeenCalled(); expect(never.reconnector.state).toBeNull();
  const test = setup(); await test.connected(); test.connect.mockClear();
  const disconnect = vi.fn(() => Promise.resolve());
  await test.reconnector.manualDisconnect(disconnect); test.drop();
  await test.advance(60_000);
  expect(disconnect).toHaveBeenCalledOnce(); expect(test.connect).not.toHaveBeenCalled(); expect(test.reconnector.state).toBeNull();
});

it('等着重连时操作员点了断开：取消等着的那次；正在连的那次等它结束再断开，连上了也不算', async () => {
  const test = setup(); await test.connected(); test.connect.mockClear();
  test.drop(); await test.reconnector.manualDisconnect(() => Promise.resolve()); await test.advance(60_000);
  expect(test.connect).not.toHaveBeenCalled();
  await test.connected(); test.connect.mockClear();
  let answer: (connected: boolean) => void = () => undefined;
  test.results.push(new Promise<boolean>(resolve => { answer = resolve; }));
  test.drop(); await test.advance(1000); expect(test.connect).toHaveBeenCalledOnce();
  const order: string[] = [];
  const disconnecting = test.reconnector.manualDisconnect(() => { order.push('disconnect'); return Promise.resolve(); });
  await flush(); expect(order).toEqual([]);
  answer(true); await disconnecting;
  expect(order).toEqual(['disconnect']); expect(test.reconnector.state).toBeNull();
  test.drop(); await test.advance(60_000); expect(test.connect).toHaveBeenCalledOnce();
});

it('操作员手动点连接时不抢：等着的那次取消，正在连的那次先等它结束，再连操作员这一次；期间的状态变化不触发重连', async () => {
  const test = setup(); await test.connected(); test.connect.mockClear();
  let answer: (connected: boolean) => void = () => undefined;
  test.results.push(new Promise<boolean>(resolve => { answer = resolve; }));
  test.drop(); await test.advance(1000); expect(test.connect).toHaveBeenCalledOnce();
  let connectOwn: () => void = () => undefined;
  const own = vi.fn(() => new Promise<LinkObsSnapshot>(resolve => { connectOwn = () => resolve(snapshot('connected')); }));
  const manual = test.reconnector.manual(own);
  await flush(); expect(own).not.toHaveBeenCalled();
  test.reconnector.observe(snapshot('error', '还在连'));
  answer(false); await vi.waitFor(() => expect(own).toHaveBeenCalledOnce());
  // The operator's own connect is under way: what OBS reports meanwhile starts nothing, and no attempt is due.
  test.reconnector.observe(snapshot('error', '操作员这次还在连'));
  await test.advance(60_000); expect(test.connect).toHaveBeenCalledOnce();
  connectOwn(); await manual;
  expect(test.reconnector.state).toBeNull();
  await test.advance(60_000); expect(test.connect).toHaveBeenCalledOnce();
  // Connected, the operator connects again and OBS reports the old connection going meanwhile: their connect owns it.
  const again = test.reconnector.manual(() => { test.reconnector.observe(snapshot('error', '换连接')); return Promise.reject(new Error('OBS WebSocket 连接失败：拒绝连接')); });
  await expect(again).rejects.toThrow('拒绝连接');
  expect(test.reconnector.state).toBeNull(); await test.advance(60_000); expect(test.connect).toHaveBeenCalledOnce();
});

it('断线期间操作员手动连接没成功：自动重连接着从原来的次数往下走，不重新数，也不多一次', async () => {
  const test = setup(); await test.connected(); test.connect.mockClear();
  test.drop(); await test.advance(1000 + 2000);
  expect(test.connect).toHaveBeenCalledTimes(2); expect(test.reconnector.state).toEqual({ state: 'waiting', attempt: 3, max });
  await expect(test.reconnector.manual(() => Promise.reject(new Error('OBS WebSocket 连接失败：密码不对')))).rejects.toThrow('密码不对');
  expect(test.reconnector.state).toEqual({ state: 'waiting', attempt: 3, max });
  await test.advance(4000); expect(test.connect).toHaveBeenCalledTimes(3);
});

it('到上限以后操作员手动连上：次数清零，再断从第 1 次开始；手动连接失败只收回红字，不再自动重连', async () => {
  const test = setup(); await test.connected(); test.connect.mockClear();
  test.drop(); await test.advance(5 * 60_000);
  expect(test.reconnector.state?.state).toBe('gave-up');
  await expect(test.reconnector.manual(() => Promise.reject(new Error('OBS WebSocket 连接失败：拒绝连接')))).rejects.toThrow();
  expect(test.reconnector.state).toBeNull(); await test.advance(60_000); expect(test.connect).toHaveBeenCalledTimes(max);
  await test.connected();
  test.drop(); expect(test.reconnector.state).toEqual({ state: 'waiting', attempt: 1, max });
  await test.advance(1000); expect(test.logs.at(-1)?.message).toBe('OBS 断开了，正在自动重连（第 1 次，最多 10 次）');
});
