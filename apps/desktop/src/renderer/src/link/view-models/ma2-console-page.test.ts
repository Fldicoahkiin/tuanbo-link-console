import { describe, expect, it } from 'vitest';
import { SHOW_WAIT_CLOCK_MOVING, SHOW_WAIT_PREPARING, SHOW_WAIT_STOPPING, type ShowState } from '@tb/core/link';
import { createLightingDocument, type LightingDocument, type Ma2ExecutorPage, type Ma2LiveSnapshot } from '@tb/schema';
import {
  MA2_CONSOLE_CONNECT_NOTE, MA2_CONSOLE_LIVE_STALE_MS, MA2_FADER_LATE_MS, holdFader, ma2ButtonLiveRow, ma2ButtonRowStart, ma2ButtonRowsToRead, ma2ConsoleBand,
  ma2ConsoleBanner, ma2ConsoleFooter, ma2ConsolePageActions, ma2ConsoleReadNote, ma2FaderLiveRow, ma2ReadsButtonLive, ma2TimecodeExecutors, settleFaders,
  type Ma2ConsoleBandInput, type Ma2ConsoleLiveRow
} from './ma2-console-page';

type Item = Ma2ExecutorPage['items'][number];
const item = (slot: number, name: string, sequence: number, width = 1): Item => ({ slot, width, name, kind: 'sequence', sequence, button: 12299, buttons: [12299], reference: ['25', '1', String(sequence)] });
const page: Ma2ExecutorPage = { page: 1000, name: '歌曲', items: [item(101, '面光', 9000), item(103, '逆光', 9001, 2), item(130, '烟机', 9002)] } as Ma2ExecutorPage;
const live = (readAt: number, items: Array<{ slot: number; width?: number; name: string; objectNumber: string; running: boolean; cue: string }>): Ma2ConsoleLiveRow =>
  ({ kind: 'read', readAt, items: items.map(entry => ({ width: 1, ...entry })), faders: [] });
const band = (input: Partial<Ma2ConsoleBandInput>): ReturnType<typeof ma2ConsoleBand> => ma2ConsoleBand({
  page: 1000, start: 101, end: 190, structure: page, rows: new Map(), rowStart: ma2ButtonRowStart, timecode: new Set(),
  keys: { sending: {}, failed: {} }, pending: new Map(), now: 10_000, ...input
});
const cell = (model: ReturnType<typeof ma2ConsoleBand>, slot: number) => model.cells.find(entry => entry.slot === slot)!;

const states: Record<string, ShowState> = {
  idle: { phase: 'idle', program: null },
  running: { phase: 'running', source: 'internal', itemId: 'song', program: null },
  preview: { phase: 'running', source: 'preview', itemId: null, program: null },
  preparing: { phase: 'preparing', source: 'internal', itemId: 'song', program: null },
  stopping: { phase: 'stopping', source: 'internal', itemId: 'song', program: null },
  paused: { phase: 'held', source: 'internal', itemId: 'song', reason: 'paused', program: null },
  ended: { phase: 'held', source: 'internal', itemId: 'song', reason: 'ended', program: null },
  p1Waiting: { phase: 'held', source: 'p1', itemId: null, reason: 'p1-waiting', program: null },
  timecodeLost: { phase: 'held', source: 'p1', itemId: 'song', reason: 'timecode-lost', program: null },
  error: { phase: 'held', source: 'internal', itemId: 'song', reason: 'error', program: null }
};

describe('控台页：各 ShowState 下能做什么（C1，问 showGate）', () => {
  it('按键在每个阶段都能按，不锁、不问', () => {
    for (const [name, show] of Object.entries(states)) expect(ma2ConsolePageActions(show).press, name).toEqual({ kind: 'allow' });
  });
  it('时间码在走、在准备、在停止时，改执行器和刷新页面结构在等，旁边写 showGate 的原话；停了、暂停、P1 在等、时间码断了都能做', () => {
    const waits = { running: SHOW_WAIT_CLOCK_MOVING, preview: SHOW_WAIT_CLOCK_MOVING, preparing: SHOW_WAIT_PREPARING, stopping: SHOW_WAIT_STOPPING } as const;
    for (const [name, opening] of Object.entries(waits)) {
      const actions = ma2ConsolePageActions(states[name]!);
      expect(actions.mutate.kind, name).toBe('wait'); expect(actions.refresh.kind, name).toBe('wait');
      expect(actions.waiting, name).toBe(actions.mutate.kind === 'wait' ? actions.mutate.message : null);
      expect(actions.waiting?.startsWith(opening), name).toBe(true);
      expect(actions.waiting, name).toContain('修改执行器');
    }
    for (const name of ['idle', 'paused', 'ended', 'p1Waiting', 'timecodeLost', 'error']) {
      const actions = ma2ConsolePageActions(states[name]!);
      expect([actions.mutate.kind, actions.refresh.kind, actions.waiting], name).toEqual(['allow', 'allow', null]);
    }
  });
  it('页面读取回来的等待显示成在等，不标红；别的错照旧是失败', () => {
    expect(ma2ConsoleReadNote(`Error invoking remote method 'link:ma2-executor-page': Error: ${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再刷新控台页。`))
      .toEqual({ kind: 'wait', text: `${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再刷新控台页。` });
    expect(ma2ConsoleReadNote('控台没有回应').kind).toBe('failed');
  });
});

describe('控台页横幅（设计 4.3.1 的表）', () => {
  it('停着没有横幅；其余每个阶段一句话，都是“演出中”开头', () => {
    expect(ma2ConsoleBanner(states.idle!)).toBeNull();
    const text = (name: string): string => { const banner = ma2ConsoleBanner(states[name]!); return `${banner?.title} · ${banner?.text}`; };
    expect(text('running')).toBe('演出中 · 时间码在走。按键和推杆立刻生效；改执行器、刷新页面结构等暂停后再做');
    expect(text('paused')).toBe('演出中 · 已暂停。可以改执行器、刷新页面');
    expect(text('ended')).toBe('演出中 · 已暂停。可以改执行器、刷新页面');
    expect(text('p1Waiting')).toBe('演出中 · P1 在等下一首。可以改执行器、刷新页面');
    expect(text('timecodeLost')).toBe('演出中 · 时间码断了。按键和推杆照常可用');
    expect(text('preparing')).toBe('演出中 · 正在开始');
    expect(text('stopping')).toBe('演出中 · 正在关灯');
    expect(text('error')).toBe('演出中 · 播放出错，停在这首歌上。可以改执行器、刷新页面');
  });
  it('横幅说“可以改”的时候 showGate 也真的放行，说“暂停后再做”的时候真的在等', () => {
    for (const show of Object.values(states)) {
      const banner = ma2ConsoleBanner(show); if (!banner) continue;
      if (banner.text.includes('可以改执行器')) expect(ma2ConsolePageActions(show).mutate.kind).toBe('allow');
      if (banner.text.includes('暂停后再做')) expect(ma2ConsolePageActions(show).mutate.kind).toBe('wait');
    }
  });
});

describe('每一格的显示', () => {
  it('“时间码在用”角标：台上那首歌的时间码跑的执行器；停着时是灯光工作台打开的那首', () => {
    const song = (executor: string): LightingDocument => ({ ...createLightingDocument(), consoleSong: { endpoint: 'e', show: 's', layout: null, executor, sequence: 9000, name: '歌', baselineXml: '<x/>' } } as LightingDocument);
    const onStage = song('1000.103'); const open = song('1000.101');
    expect([...ma2TimecodeExecutors(states.running!, id => id === 'song' ? onStage : null, open)]).toEqual(['1000.103']);
    expect([...ma2TimecodeExecutors(states.idle!, () => onStage, open)]).toEqual(['1000.101']);
    // P1 not saying which song: the one open.
    expect([...ma2TimecodeExecutors(states.p1Waiting!, () => onStage, open)]).toEqual(['1000.101']);
    const model = band({ timecode: new Set(['1000.103', '1000.102']) });
    expect(cell(model, 103).timecode).toBe(true); expect(cell(model, 101).timecode).toBe(false);
    // 102 is empty on the page: nothing to mark.
    expect(cell(model, 102).timecode).toBe(false);
  });
  it('在跑和当前 Cue 只看控台读回；超过 3 秒没读回显示成旧的；控台上这一格变了就说请刷新', () => {
    const now = 10_000;
    const rows = new Map<number, Ma2ConsoleLiveRow>([
      [101, live(now - 100, [{ slot: 101, name: '面光', objectNumber: '9000', running: true, cue: '3 副歌' }, { slot: 103, width: 2, name: '侧光', objectNumber: '9001', running: false, cue: '' }])],
      [116, live(now - MA2_CONSOLE_LIVE_STALE_MS - 1, [{ slot: 130, name: '烟机', objectNumber: '9002', running: true, cue: '1' }])]
    ]);
    const model = band({ rows, now });
    expect(cell(model, 101).live).toEqual({ kind: 'live', running: true, cue: '3 副歌', stale: false });
    expect(cell(model, 103).live).toEqual({ kind: 'changed', message: '控台上这一格变了，请刷新页面' });
    expect(cell(model, 130).live).toEqual({ kind: 'live', running: true, cue: '1', stale: true });
    // A continuation slot of 103 is not a cell of its own.
    expect(model.cells.some(entry => entry.slot === 104)).toBe(false);
    const empty = band({ rows: new Map([[101, live(now, [])]]), now });
    expect(cell(empty, 101).live).toEqual({ kind: 'changed', message: '控台上这一格现在是空的，请刷新页面' });
  });
  it('没选网页遥控时 Button 区没有实时状态，只说一句怎么才有；不读（ma2ReadsButtonLive）', () => {
    expect(ma2ReadsButtonLive(true, 'plugin')).toBe(false); expect(ma2ReadsButtonLive(true, null)).toBe(false); expect(ma2ReadsButtonLive(false, 'webRemote')).toBe(false);
    expect(ma2ReadsButtonLive(true, 'webRemote')).toBe(true);
    const plugin = ma2ButtonLiveRow({ kind: 'not-asked', why: 'plugin' });
    const model = band({ rows: new Map([[101, plugin], [116, plugin], [131, plugin]]) });
    expect(model.cells.every(entry => entry.live.kind === 'none')).toBe(true);
    expect(model.note).toEqual({ text: 'Button 区的按键走控台插件，这里只显示页面结构。想看控台上哪一格在跑，在“按键”菜单里选“网页遥控”', tone: 'normal' });
    expect(ma2ButtonLiveRow({ kind: 'off', why: 'plugin', reason: '' })).toEqual(plugin);
    expect(ma2ButtonLiveRow({ kind: 'not-asked', why: 'above-190' })).toEqual({ kind: 'off', note: '191 以后的格子网页遥控读不了，这里只显示页面结构' });
  });
  it('只读有执行器的那几行，191 以后和空行不读；上下两栏同一行只读一次', () => {
    const lower = { page: 1000, start: 101, end: 115, structure: page };
    expect(ma2ButtonRowsToRead([{ page: 1000, start: 101, end: 190, structure: page }, lower])).toEqual(['1000:101', '1000:116']);
    expect(ma2ButtonRowsToRead([{ page: 1000, start: 191, end: 240, structure: { ...page, items: [item(200, '远处', 9100)] } }])).toEqual([]);
    expect(ma2ButtonRowsToRead([{ page: null, start: 101, end: 190, structure: page }, { page: 1000, start: 101, end: 190, structure: undefined }])).toEqual([]);
  });
  it('推杆区没连网页遥控：只说“连接网页遥控后显示控台实时状态”；读不到就写原因', () => {
    expect(ma2FaderLiveRow({ wanted: false, start: 1, snapshot: null, error: '' })).toEqual({ kind: 'off', note: MA2_CONSOLE_CONNECT_NOTE });
    expect(ma2FaderLiveRow({ wanted: true, start: 91, snapshot: null, error: '' }).kind).toBe('off');
    expect(ma2FaderLiveRow({ wanted: true, start: 1, snapshot: null, error: '' })).toEqual({ kind: 'reading' });
    const failed = ma2ConsoleBand({ page: 1, start: 1, end: 15, structure: { page: 1, name: '', items: [item(1, '面光', 86)] } as Ma2ExecutorPage,
      rows: new Map([[1, ma2FaderLiveRow({ wanted: true, start: 1, snapshot: null, error: '网页遥控没有回应' })]]), rowStart: () => 1, timecode: new Set(), keys: { sending: {}, failed: {} }, pending: new Map(), now: 0 });
    expect(failed.note).toEqual({ text: '读不到控台上这几格现在的状态。原因：网页遥控没有回应', tone: 'warning' });
  });
  it('一格按键失败只这一格红，正在按的显示按下；别的格照旧', () => {
    const model = band({ keys: { sending: { '1000.130': 1 }, failed: { '1000.101': '控台上这一格变了，请刷新页面' } } });
    expect(cell(model, 101).key).toEqual({ kind: 'failed', message: '控台上这一格变了，请刷新页面' });
    expect(cell(model, 130).key).toEqual({ kind: 'sending' });
    expect(cell(model, 103).key).toEqual({ kind: 'idle' });
  });
});

describe('推杆 1.5 秒没读回目标值（设计 4.3.2）', () => {
  const read = (value: number, readAt: number): Ma2LiveSnapshot => ({ page: 1, start: 1, readAt, items: [{ slot: 1, width: 1, name: '面光', objectType: 'Seq', objectNumber: '86', running: true, cue: '1',
    blocks: [{ slot: 1, fader: { value, min: 0, max: 1, name: 'Master', text: `${Math.round(value * 100)}%` }, buttons: [] }] }] });
  it('黄字“控台还没显示这个值”，不停、不报错；下一次拖动从头等，照常发', () => {
    let pending = holdFader(new Map(), 1, 0.8, 1000);
    pending = settleFaders(pending, read(0.2, 1100), 1100);
    expect(pending.get(1)).toEqual({ value: 0.8, at: 1000, late: false });
    pending = settleFaders(pending, read(0.2, 1000 + MA2_FADER_LATE_MS + 1), 1000 + MA2_FADER_LATE_MS + 1);
    expect(pending.get(1)).toEqual({ value: 0.8, at: 1000, late: true });
    const row = ma2FaderLiveRow({ wanted: true, start: 1, snapshot: read(0.2, 3000), error: '' });
    const model = ma2ConsoleBand({ page: 1, start: 1, end: 15, structure: { page: 1, name: '', items: [item(1, '面光', 86)] } as Ma2ExecutorPage, rows: new Map([[1, row]]), rowStart: () => 1,
      timecode: new Set(), keys: { sending: {}, failed: {} }, pending, now: 3000 });
    expect(model.cells[0]!.fader).toMatchObject({ value: 0.8, state: 'late', note: '控台还没显示这个值' });
    // The next drag waits afresh; the console showing it ends the wait.
    pending = holdFader(pending, 1, 0.5, 4000);
    expect(pending.get(1)).toEqual({ value: 0.5, at: 4000, late: false });
    expect(settleFaders(pending, read(0.5, 4100), 4100).size).toBe(0);
  });
});

describe('页脚', () => {
  it('写明按键和推杆怎么到控台，网页遥控没连时给“连接网页遥控”', () => {
    const footer = ma2ConsoleFooter({ kind: 'off' }, { text: '按键：控台插件', tone: 'normal' });
    expect(footer.keys).toBe('推杆区按键：控台插件 · 推杆：网页遥控 · Button 区按键：控台插件。走控台插件的按键，同步时最多慢一步');
    expect(footer.webRemote).toBe(`网页遥控没连上。${MA2_CONSOLE_CONNECT_NOTE}`); expect(footer.connect).toBe(true);
    expect(ma2ConsoleFooter({ kind: 'connected' }, { text: '按键：网页遥控', tone: 'normal' })).toMatchObject({ webRemote: '网页遥控已连上，推杆区显示控台当前值', connect: false });
    expect(ma2ConsoleFooter({ kind: 'failed', reason: '超时' }, { text: '按键：网页遥控', tone: 'normal' })).toMatchObject({ webRemote: '网页遥控停了，推杆区的实时状态没有更新。原因：超时', webRemoteTone: 'warning', connect: true });
  });
});
