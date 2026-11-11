import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Ma2LiveService } from './ma2-live-service';
import { Ma2WebRemoteConsole } from './fixtures/ma2-web-remote-console';

// C1 (2026-11-11): the console page's Button rows, read through the real live service and the real web remote client on a
// fake console. Nothing is read with the console plugin chosen; with the web remote chosen and read back, each row goes on
// the Button session's own one-second cache, never logged in for, and an answer it cannot read leaves the session alone.
const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' };
const source = { show: 'TEST', generation: '1', version: '3.3.4.3' };
const row = (start = 101) => ({ network, expectedSource: source, page: 1000, start });

async function rig() {
  const ma2 = new Ma2WebRemoteConsole();
  ma2.running.set('1000.101', true); ma2.running.set('1000.120', false);
  const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
  const telnet = { command: (line: string, match: (text: string) => string | null) => {
    const marker = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
    return Promise.resolve(marker ? match(`${marker}:${hex(source.show)},${hex(source.generation)},${hex(source.version)}\r\n`) ?? '' : 'ACK');
  } };
  const dir = await mkdtemp(join(tmpdir(), 'tblink-console-live-'));
  await writeFile(join(dir, 'profiles.json'), JSON.stringify([{ host: network.host, username: 'web' }]));
  const live = new Ma2LiveService(join(dir, 'profiles.json'), { saveCredential: () => Promise.resolve(), loadCredential: () => Promise.resolve('web-secret') }, () => telnet,
    () => ma2.playback('buttons'), () => ma2.playback('faders'));
  await live.connect({ network, expectedSource: source, username: 'web', password: 'web-secret', page: 1000, start: 1 });
  /** One row asked as the page asks it, with fake time moving on until it answers. */
  const ask = async (start = 101) => {
    const answer = live.buttonLive(row(start)).then(value => value, (error: unknown) => error instanceof Error ? error : new Error(String(error)));
    await vi.advanceTimersByTimeAsync(50);
    return answer;
  };
  return { ma2, live, ask, buttonReads: () => ma2.requests.filter(request => request.startsWith('buttons')) };
}

afterEach(() => { vi.useRealTimers(); });

describe('控台页 Button 区实时状态（C1）', () => {
  it('选的是控台插件：不读、不登录，只说 Button 区的按键走控台插件', async () => {
    const f = await rig();
    try {
      f.ma2.requests.length = 0; const logins = f.ma2.logins.length;
      vi.useFakeTimers();
      expect(await f.ask()).toEqual({ kind: 'off', why: 'plugin', reason: 'Button 区的按键走控台插件' });
      expect(await f.ask(116)).toMatchObject({ kind: 'off', why: 'plugin' });
      expect(f.ma2.requests).toEqual([]); expect(f.ma2.logins.length).toBe(logins);
    } finally { f.live.close(); }
  });

  it('选了网页遥控并读回过：每行在 Button 会话上读，一秒内再问不再发；读到的是在跑和当前 Cue', async () => {
    const f = await rig();
    try {
      await f.live.chooseKeys('webRemote');
      f.ma2.requests.length = 0; const logins = f.ma2.logins.length;
      // The choice read row 101 just now: it is not asked again within the second.
      vi.useFakeTimers();
      expect(await f.ask()).toMatchObject({ kind: 'live', start: 101 });
      expect(f.buttonReads()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1001);
      const first = await f.ask();
      expect(first).toMatchObject({ kind: 'live', page: 1000, start: 101, items: [{ slot: 101, running: true, cue: '1 Cue', name: 'Exec 1000.101' }] });
      expect(await f.ask()).toEqual(first);
      expect(await f.ask(116)).toMatchObject({ kind: 'live', start: 116, items: [{ slot: 120, running: false }] });
      expect(f.buttonReads()).toEqual(['buttons 1000.101', 'buttons 1000.116']);
      await vi.advanceTimersByTimeAsync(1000);
      await f.ask();
      expect(f.buttonReads()).toEqual(['buttons 1000.101', 'buttons 1000.116', 'buttons 1000.101']);
      // Nothing logs in for it, and the fader view's own session is never asked.
      expect(f.ma2.logins.length).toBe(logins);
      expect(f.ma2.requests.every(request => request.startsWith('buttons'))).toBe(true);
    } finally { f.live.close(); }
  });

  it('看不懂的回答只报这一次，Button 会话照旧连着，下一秒照常读；之后按键也照常走网页遥控', async () => {
    const f = await rig();
    try {
      await f.live.chooseKeys('webRemote');
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(1001);
      f.ma2.garble = { page: 1000, count: 1 };
      const failed = await f.ask();
      expect(failed).toBeInstanceOf(Error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await f.ask()).toMatchObject({ kind: 'live', items: [{ slot: 101, running: true }] });
      expect(f.live.keyChannel({ network, expectedSource: source }, 101)).toBe('webRemote');
      expect(f.ma2.logins.filter(name => name.startsWith('buttons'))).toEqual(['buttons']);
    } finally { f.live.close(); }
  });

  it('选了网页遥控但这一页 Button 区读不回：不读，写明原因', async () => {
    const f = await rig();
    try {
      f.ma2.running.clear();
      await f.live.chooseKeys('webRemote');
      f.ma2.requests.length = 0;
      vi.useFakeTimers();
      const answer = await f.ask();
      expect(answer).toMatchObject({ kind: 'off', why: 'unverified' });
      expect(f.ma2.requests).toEqual([]);
    } finally { f.live.close(); }
  });
});
