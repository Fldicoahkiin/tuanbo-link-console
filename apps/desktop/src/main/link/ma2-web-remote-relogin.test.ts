import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_RECOVERY_RULES } from '@tb/core/link';
import { Ma2LiveService } from './ma2-live-service';
import { Ma2ReloginStop, Ma2WebRemoteRelogin, type Ma2ReloginClock, type Ma2ReloginLog } from './ma2-web-remote-relogin';
import { Ma2WebRemoteConsole } from './fixtures/ma2-web-remote-console';

// C2 (2026-11-11): the console page's web remote sessions log in again on their own when they drop, with the saved user
// only, on the waits 1, 2, 4, 8, 15, 30, 30 … s and within the recovery table's five minutes for one outage. The real live
// service and the real web remote client on a fake console.
const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' };
const LIMIT_TEXT = OUTPUT_RECOVERY_RULES['ma2.webRemote.relogin'].limitText;

async function rig(options: { credential?: () => Promise<string> } = {}) {
  const ma2 = new Ma2WebRemoteConsole();
  ma2.running.set('1000.1', true); ma2.running.set('1000.101', true); ma2.faders = true;
  const source = { show: 'TEST', generation: '1', version: '3.3.4.3' };
  const expected = { ...source };
  const telnetState = { down: false };
  const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
  const telnet = { command: (line: string, match: (text: string) => string | null) => {
    const marker = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
    return Promise.resolve(marker ? match(`${marker}:${hex(source.show)},${hex(source.generation)},${hex(source.version)}\r\n`) ?? '' : 'ACK');
  } };
  const dir = await mkdtemp(join(tmpdir(), 'tblink-relogin-'));
  await writeFile(join(dir, 'profiles.json'), JSON.stringify([{ host: network.host, username: 'web' }]));
  const credential = vi.fn(options.credential ?? (() => Promise.resolve('web-secret')));
  const live = new Ma2LiveService(join(dir, 'profiles.json'), { saveCredential: () => Promise.resolve(), loadCredential: credential },
    () => { if (telnetState.down) throw new Error('请先连接控台'); return telnet; },
    (_host, dropped) => ma2.playback('buttons', dropped), (_host, dropped) => ma2.playback('faders', dropped));
  const logs: Ma2ReloginLog[] = [];
  live.onReloginLog(entry => logs.push(entry));
  const scope = { network, expectedSource: expected };
  const connect = () => live.connect({ network, expectedSource: expected, username: 'web', password: 'web-secret', page: 1000, start: 1 });
  return { ma2, live, logs, source, telnetState, credential, scope, connect, state: () => live.webRemoteState(scope),
    faderLogins: () => ma2.logins.filter(name => name.startsWith('faders')).length, buttonLogins: () => ma2.logins.filter(name => name.startsWith('buttons')).length };
}
/** Fake time moves on by `ms`; then whatever that started (a login and its answers) runs to its end. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  // A zero wait set while fake time moves counts as 1 ms, so this moves on 1 ms at a time, at most 20 ms in all.
  for (let turn = 0; turn < 20; turn += 1) await vi.advanceTimersByTimeAsync(1);
}
/** Fake timers, leaving setImmediate real so that a file written meanwhile (the operator's own connect) can finish. */
const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

afterEach(() => { vi.useRealTimers(); });

describe('网页遥控断了自动重新登录（C2）', () => {
  it('这次运行里没连过：什么都不连，等多久也不登录；按键走控台插件时 Button 区也不连', async () => {
    const f = await rig();
    fake();
    try {
      await pass(10 * 60_000);
      expect(f.ma2.logins).toEqual([]); expect(f.ma2.requests).toEqual([]);
      expect(f.state()).toEqual({ fader: { kind: 'idle' }, buttons: { kind: 'idle' } });
    } finally { f.live.close(); vi.useRealTimers(); }
    const g = await rig();
    try {
      await g.connect();
      fake();
      g.ma2.drop('faders');
      await pass(1000);
      // The fader view logs in again; with the console plugin chosen no Button session is ever opened.
      expect(g.faderLogins()).toBe(2); expect(g.buttonLogins()).toBe(0);
      await pass(10 * 60_000);
      expect(g.buttonLogins()).toBe(0);
    } finally { g.live.close(); }
  });

  it('推杆区断了：照 1、2、4、8、15、30 秒的间隔用保存的用户重新登录，每次记日志，登上后清零、不重发推杆值', async () => {
    const f = await rig();
    try {
      await f.connect();
      fake();
      f.live.input({ network, expectedSource: f.scope.expectedSource, page: 1000, start: 1, slot: 1, action: { kind: 'fader', value: 0.5 }, deadlineAt: Date.now() + 500 });
      const inputs = f.ma2.inputs.length;
      expect(inputs).toBe(1);
      f.ma2.unreachable = true;
      f.ma2.drop('faders');
      expect(f.state().fader).toMatchObject({ kind: 'relogin', attempt: 1 });
      await expect(f.live.read({ network, expectedSource: f.scope.expectedSource, page: 1000, start: 1 })).rejects.toThrow('网页遥控断了，正在自动重新登录（第 1 次）');
      // Attempts 1–6 at 1, 3, 7, 15, 30 and 60 s after the drop; each one a new socket.
      const opens: number[] = [];
      for (const wait of [1000, 2000, 4000, 8000, 15_000, 30_000]) { await pass(wait); opens.push(f.ma2.opens('faders')); }
      expect(opens).toEqual([2, 3, 4, 5, 6, 7]);
      expect(f.state().fader).toMatchObject({ kind: 'relogin', attempt: 7 });
      expect(f.logs.map(entry => [entry.level, entry.result, entry.details.attempt])).toEqual([1, 2, 3, 4, 5, 6].map(attempt => ['info', 'queued', attempt]));
      expect(f.logs[0]!.message).toMatch(/^网页遥控（推杆区）断了，第 1 次自动重新登录：已经断了 1 秒，最多试 5 分钟。断开的原因：/);
      expect(f.logs[5]!.details).toMatchObject({ session: 'fader', attempt: 6, limitMs: 300_000 });
      expect(f.logs[5]!.details.outageMs).toBeGreaterThanOrEqual(60_000); expect(f.logs[5]!.details.outageMs).toBeLessThan(61_000);
      // The console answers again: the next attempt gets in, and nothing is sent again.
      f.ma2.unreachable = false;
      await pass(30_000);
      expect(f.state().fader).toEqual({ kind: 'connected' });
      expect(f.logs.at(-1)).toMatchObject({ level: 'info', result: 'succeeded', message: '网页遥控（推杆区）自动重新登录成功：第 7 次登上，断了 90 秒' });
      expect(f.ma2.inputs.length).toBe(inputs);
      const read = f.live.read({ network, expectedSource: f.scope.expectedSource, page: 1000, start: 1 });
      await pass(50);
      expect(await read).toMatchObject({ page: 1000, start: 1 });
      // A later outage counts from the first wait again.
      f.ma2.drop('faders#8');
      await pass(1000);
      expect(f.logs.at(-1)).toMatchObject({ result: 'succeeded', details: { attempt: 1 } });
      expect(f.credential).toHaveBeenCalled();
    } finally { f.live.close(); }
  });

  it('一次断线 5 分钟还没登上：停下、记一条 error、标红用表里的话，不再试；手动连上后照常，次数清零', async () => {
    const f = await rig();
    try {
      await f.connect();
      fake();
      f.ma2.unreachable = true;
      f.ma2.drop('faders');
      await pass(6 * 60_000);
      expect(f.state().fader).toEqual({ kind: 'stopped', reason: LIMIT_TEXT, limit: true });
      const last = f.logs.at(-1)!;
      expect(last).toMatchObject({ level: 'error', result: 'failed' });
      expect(last.message.startsWith(LIMIT_TEXT)).toBe(true);
      expect(f.logs.filter(entry => entry.level === 'error')).toHaveLength(1);
      // Waiting is never written as an error.
      expect(f.logs.slice(0, -1).every(entry => entry.level === 'info' && entry.result === 'queued')).toBe(true);
      const opens = f.ma2.opens('faders');
      await pass(10 * 60_000);
      expect(f.ma2.opens('faders')).toBe(opens);
      // The operator connects (it writes the saved user to disk, so in real time); nothing was waiting any more.
      f.ma2.unreachable = false;
      vi.useRealTimers();
      await f.connect();
      expect(f.state().fader).toEqual({ kind: 'connected' });
      fake();
      f.ma2.drop('faders');
      expect(f.state().fader).toMatchObject({ kind: 'relogin', attempt: 1 });
      await pass(1000);
      expect(f.state().fader).toEqual({ kind: 'connected' });
      expect(f.logs.at(-1)).toMatchObject({ result: 'succeeded', details: { attempt: 1 } });
    } finally { f.live.close(); }
  });

  it('控台拒绝登录、没有保存的用户、安全存储不可用、Show 变了：都不重试，停下写明原因', async () => {
    const refused = await rig();
    try {
      await refused.connect();
      fake();
      refused.ma2.refuse = true;
      refused.ma2.drop('faders');
      await pass(1000);
      expect(refused.state().fader).toEqual({ kind: 'stopped', reason: '控台拒绝登录，请检查实时推杆用户名和密码', limit: false });
      expect(refused.logs.at(-1)).toMatchObject({ level: 'error', message: '网页遥控（推杆区）没有再自动重新登录：控台拒绝登录，请检查实时推杆用户名和密码' });
      const logins = refused.faderLogins();
      await pass(10 * 60_000);
      expect(refused.faderLogins()).toBe(logins);
    } finally { refused.live.close(); vi.useRealTimers(); }

    let store = true;
    const locked = await rig({ credential: () => store ? Promise.resolve('web-secret') : Promise.reject(new Error('Windows 安全存储不可用，无法读取密码')) });
    try {
      await locked.connect();
      fake();
      store = false;
      locked.ma2.drop('faders');
      await pass(1000);
      expect(locked.state().fader).toEqual({ kind: 'stopped', reason: 'Windows 安全存储不可用，无法读取密码', limit: false });
      // Nothing was opened for it: the password never left the store, and none is kept anywhere else.
      expect(locked.ma2.opens('faders')).toBe(1);
      await pass(10 * 60_000);
      expect(locked.ma2.opens('faders')).toBe(1);
    } finally { locked.live.close(); vi.useRealTimers(); }

    const changed = await rig();
    try {
      await changed.connect();
      fake();
      changed.source.show = 'OTHER';
      changed.ma2.drop('faders');
      await pass(1000);
      expect(changed.state().fader).toMatchObject({ kind: 'stopped', limit: false, reason: '控台的 Show 或连接变了，请重新读取素材；这一页没有使用旧数据' });
      expect(changed.ma2.opens('faders')).toBe(1);
    } finally { changed.live.close(); }
  });

  it('联动台和控台之间的 Telnet 暂时没连上：算一次没登上，按间隔接着试', async () => {
    const f = await rig();
    try {
      await f.connect();
      fake();
      f.telnetState.down = true;
      f.ma2.drop('faders');
      await pass(1000 + 2000);
      expect(f.state().fader).toMatchObject({ kind: 'relogin', attempt: 3, reason: '请先连接控台' });
      f.telnetState.down = false;
      await pass(4000);
      expect(f.state().fader).toEqual({ kind: 'connected' });
    } finally { f.live.close(); }
  });

  it('M5：Telnet 重新登上的是同一台控台、同一个 Show，只是插件会话变了：网页遥控接着登、接着读；Show 变了就停下等人', async () => {
    const f = await rig();
    try {
      await f.connect();
      fake();
      f.telnetState.down = true;
      f.ma2.drop('faders');
      await pass(1000);
      // The console restarted with the same Show: its plugin is gone, so its session reads empty.
      const before = { ...f.source };
      f.source.generation = '';
      f.live.consoleBack(before, { ...f.source });
      f.telnetState.down = false;
      await pass(2000);
      expect(f.state().fader).toEqual({ kind: 'connected' });
      const read = f.live.read({ network, expectedSource: f.scope.expectedSource, page: 1000, start: 1 });
      await pass(1100);
      await expect(read).resolves.toMatchObject({ page: 1000 });
      // Logged in again a second time on a newer session: the page read on the first still stands.
      const middle = { ...f.source };
      f.source.generation = '2';
      f.live.consoleBack(middle, { ...f.source });
      const opens = f.ma2.opens('faders');
      f.ma2.drop('faders');
      await pass(1000);
      expect(f.ma2.opens('faders')).toBe(opens + 1);
      expect(f.state().fader).toEqual({ kind: 'connected' });
      // Another Show: nothing carries over, it stops and waits for a person.
      f.source.show = 'OTHER';
      f.ma2.drop('faders');
      await pass(1000);
      expect(f.state().fader).toMatchObject({ kind: 'stopped', limit: false, reason: '控台的 Show 或连接变了，请重新读取素材；这一页没有使用旧数据' });
    } finally { f.live.close(); }
  });

  it('M5：没有 Telnet 重新登上的说法，插件会话变了照旧停下（C1 的规矩不变）', async () => {
    const f = await rig();
    try {
      await f.connect();
      fake();
      f.source.generation = '';
      f.ma2.drop('faders');
      await pass(1000);
      expect(f.state().fader).toMatchObject({ kind: 'stopped', limit: false });
      expect(JSON.stringify(f.state().fader)).toContain('插件没在运行');
    } finally { f.live.close(); }
  });

  it('操作员手动点连接时让路：之后不再自己试，换了控台或 Show（close）就停', async () => {
    const f = await rig();
    try {
      await f.connect();
      f.ma2.drop('faders');
      expect(f.state().fader).toMatchObject({ kind: 'relogin', attempt: 1 });
      // Before the first wait is over, the operator connects.
      await f.connect();
      expect(f.state().fader).toEqual({ kind: 'connected' });
      fake();
      const opens = f.ma2.opens('faders');
      await pass(60_000);
      expect(f.ma2.opens('faders')).toBe(opens);
      expect(f.logs).toEqual([]);
      f.ma2.drop('faders');
      expect(f.state().fader).toMatchObject({ kind: 'relogin', attempt: 1 });
      // Another Show: the page asks for it, and the old session is closed and not logged in again.
      f.live.close();
      expect(f.state().fader).toEqual({ kind: 'idle' });
      await pass(10 * 60_000);
      expect(f.ma2.opens('faders')).toBe(opens);
    } finally { f.live.close(); }
  });

  it('Button 会话断了：按着的键松开、不重发；状态说正在重新登录；登上后通道不变、不重新试读 Button 区', async () => {
    const f = await rig();
    try {
      await f.connect();
      await f.live.chooseKeys('webRemote');
      expect(f.live.keyChannel(f.scope, 101)).toBe('webRemote');
      fake();
      const item = { slot: 101, width: 1, name: 'Exec 1000.101', kind: 'sequence' as const, sequence: 1, button: 12302, buttons: [12302], reference: ['25', '1', '1'] };
      const press = f.live.inputButton({ network, expectedSource: f.scope.expectedSource, page: 1000, slot: 101, button: 0, pressed: true, sessionId: '11111111-1111-4111-8111-111111111111', channel: 'webRemote', deadlineAt: Date.now() + 5000, expectedItem: item });
      await pass(50);
      expect(await press).toMatchObject({ slot: 101 });
      const inputs = f.ma2.inputs.length;
      const buttonReads = f.ma2.requests.filter(request => request.startsWith('buttons')).length;
      f.ma2.unreachable = true;
      f.ma2.drop('buttons');
      expect(f.state().buttons).toMatchObject({ kind: 'relogin', attempt: 1 });
      expect(await f.live.buttonLive({ network, expectedSource: f.scope.expectedSource, page: 1000, start: 101 })).toEqual({ kind: 'relogin', attempt: 1 });
      // The lights-off read-back borrows only a connected session: it reads nothing and logs nothing in.
      expect(await f.live.readBack(network, ['1000.101'])).toEqual(new Map([['1000.101', { verified: 'unknown', reason: 'Button 区的网页遥控没连着', read: false }]]));
      await pass(1000 + 2000);
      expect(f.live.keyChannel(f.scope, 101)).toBe('webRemote');
      f.ma2.unreachable = false;
      await pass(4000);
      expect(f.state().buttons).toEqual({ kind: 'connected' });
      expect(f.logs.at(-1)).toMatchObject({ result: 'succeeded', details: { session: 'buttons', attempt: 3 } });
      // The held key was let go with its session; nothing was sent on the new one, and the Button area was not read to choose again.
      expect(f.ma2.inputs.length).toBe(inputs);
      expect(f.ma2.requests.filter(request => request.startsWith('buttons')).length).toBe(buttonReads);
      expect(f.live.keyChannel(f.scope, 101)).toBe('webRemote');
      // The fader view was never touched.
      expect(f.faderLogins()).toBe(1);
      // The next press goes as usual.
      const next = f.live.inputButton({ network, expectedSource: f.scope.expectedSource, page: 1000, slot: 101, button: 0, pressed: true, sessionId: '22222222-2222-4222-8222-222222222222', channel: 'webRemote', deadlineAt: Date.now() + 5000, expectedItem: item });
      await pass(50);
      expect(await next).toMatchObject({ slot: 101 });
    } finally { f.live.close(); }
  });

  it('按键改回控台插件：Button 会话断了也不再登录', async () => {
    const f = await rig();
    try {
      await f.connect();
      await f.live.chooseKeys('webRemote');
      fake();
      const logins = f.buttonLogins();
      f.ma2.drop('buttons');
      await f.live.chooseKeys('plugin');
      await pass(10 * 60_000);
      expect(f.buttonLogins()).toBe(logins);
      expect(f.state().buttons).toEqual({ kind: 'idle' });
    } finally { f.live.close(); }
  });
});

describe('重新登录的节奏（C2，引擎本身）', () => {
  /** A clock the test moves by hand. */
  function clock() {
    let now = 0; const timers: { at: number; run: () => void }[] = [];
    const value: Ma2ReloginClock & { move(ms: number): Promise<void>; pending(): number } = {
      now: () => now,
      after: (ms, run) => { const timer = { at: now + ms, run }; timers.push(timer); return () => { timers.splice(timers.indexOf(timer), 1); }; },
      async move(ms) {
        const end = now + ms;
        for (;;) {
          const next = timers.filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
          if (!next) break;
          timers.splice(timers.indexOf(next), 1); now = next.at; next.run();
          for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
        }
        now = end;
      },
      pending: () => timers.length
    };
    return value;
  }

  it('只有连上过的才重新登录；手动连接或换控台（stop、connected）让路，计时作废、次数清零', async () => {
    const time = clock(); const logins: number[] = []; const logs: Ma2ReloginLog[] = [];
    let fail = true;
    const relogin = new Ma2WebRemoteRelogin<string>('fader', () => { logins.push(time.now()); return fail ? Promise.reject(new Error('网络断了')) : Promise.resolve(); }, entry => logs.push(entry), time);
    relogin.dropped('断了');
    await time.move(10 * 60_000);
    expect(logins).toEqual([]); expect(relogin.view('a')).toBeNull();
    relogin.connected('a', 'target');
    relogin.dropped('断了');
    await time.move(1000 + 2000 + 4000);
    const from = 10 * 60_000;
    expect(logins).toEqual([from + 1000, from + 3000, from + 7000]);
    expect(relogin.view('a')).toMatchObject({ kind: 'relogin', attempt: 4 });
    expect(relogin.view('b')).toBeNull();
    // The operator connected by hand: the wait for attempt 4 is gone.
    relogin.connected('a', 'target');
    expect(time.pending()).toBe(0);
    await time.move(60_000);
    expect(logins).toHaveLength(3);
    // The next outage starts from the first wait, with its own five minutes.
    relogin.dropped('又断了');
    await time.move(1000);
    expect(logins.at(-1)).toBe(from + 68_000);
    relogin.stop();
    expect(relogin.view('a')).toBeNull(); expect(time.pending()).toBe(0);
    fail = false;
    relogin.dropped('断了');
    await time.move(60_000);
    expect(logins).toHaveLength(4);
  });

  it('需要人处理的错误不重试；到上限时写表里的话', async () => {
    const time = clock(); const logs: Ma2ReloginLog[] = []; let attempts = 0;
    const stop = new Ma2WebRemoteRelogin<string>('buttons', () => { attempts += 1; return Promise.reject(new Ma2ReloginStop('没有保存的用户')); }, entry => logs.push(entry), time);
    stop.connected('a', 't'); stop.dropped('断了');
    await time.move(10 * 60_000);
    expect(attempts).toBe(1);
    expect(stop.view('a')).toEqual({ kind: 'stopped', reason: '没有保存的用户', limit: false });
    expect(logs.at(-1)).toMatchObject({ level: 'error', message: '网页遥控（Button 区）没有再自动重新登录：没有保存的用户' });

    const limited = new Ma2WebRemoteRelogin<string>('fader', () => Promise.reject(new Error('超时')), entry => logs.push(entry), time);
    limited.connected('a', 't'); limited.dropped('断了');
    await time.move(10 * 60_000);
    expect(limited.view('a')).toEqual({ kind: 'stopped', reason: LIMIT_TEXT, limit: true });
    expect(time.pending()).toBe(0);
  });
});
