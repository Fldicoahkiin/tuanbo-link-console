import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ShowState } from '@tb/core/link';
import { Ma2ConsoleBanner, Ma2ConsoleCellStatus, Ma2ConsoleFooter } from './Ma2ConsolePage';
import { ma2ConsoleBanner, ma2ConsoleFooter, type Ma2ConsoleCell } from '../view-models/ma2-console-page';

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);

const text = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const banner = (show: ShowState): string => renderToStaticMarkup(React.createElement(Ma2ConsoleBanner, { banner: ma2ConsoleBanner(show) }));

describe('控台页横幅（SSR）', () => {
  it('每种状态的文字，蓝点、不用红色；停着时什么都不画', () => {
    expect(banner({ phase: 'idle', program: null })).toBe('');
    const shows: Array<[ShowState, string]> = [
      [{ phase: 'running', source: 'internal', itemId: 's', program: null }, '演出中·时间码在走。按键和推杆立刻生效；改执行器、刷新页面结构等暂停后再做'],
      [{ phase: 'held', source: 'internal', itemId: 's', reason: 'paused', program: null }, '演出中·已暂停。可以改执行器、刷新页面'],
      [{ phase: 'held', source: 'internal', itemId: 's', reason: 'ended', program: null }, '演出中·已暂停。可以改执行器、刷新页面'],
      [{ phase: 'held', source: 'p1', itemId: null, reason: 'p1-waiting', program: null }, '演出中·P1 在等下一首。可以改执行器、刷新页面'],
      [{ phase: 'held', source: 'p1', itemId: 's', reason: 'timecode-lost', program: null }, '演出中·时间码断了。按键和推杆照常可用'],
      [{ phase: 'preparing', source: 'internal', itemId: 's', program: null }, '演出中·正在开始'],
      [{ phase: 'stopping', source: 'internal', itemId: 's', program: null }, '演出中·正在关灯']
    ];
    for (const [show, words] of shows) {
      const html = banner(show);
      expect(text(html)).toBe(words);
      expect(html).toContain('class="ma2-console-banner"'); expect(html).toContain('role="status"'); expect(html).toContain('ma2-console-banner-dot');
      expect(html).not.toContain('role="alert"'); expect(html).not.toContain('danger');
    }
  });
});

describe('控台页页脚（SSR）', () => {
  it('写按键和推杆怎么到控台、网页遥控的状态；没连时给“连接网页遥控”，连上了不给', () => {
    const off = text(renderToStaticMarkup(React.createElement(Ma2ConsoleFooter, { footer: ma2ConsoleFooter({ kind: 'off' }, { text: '按键：控台插件', tone: 'normal' }), connecting: false, onConnect: () => Promise.resolve() })));
    expect(off).toContain('推杆区按键：控台插件 · 推杆：网页遥控 · Button 区按键：控台插件。走控台插件的按键，同步时最多慢一步');
    expect(off).toContain('网页遥控没连上。连接网页遥控后显示控台实时状态');
    expect(off).toContain('连接网页遥控');
    const on = renderToStaticMarkup(React.createElement(Ma2ConsoleFooter, { footer: ma2ConsoleFooter({ kind: 'connected' }, { text: '按键：网页遥控', tone: 'normal' }), connecting: false, onConnect: () => Promise.resolve() }));
    expect(text(on)).toContain('Button 区按键：网页遥控');
    expect(text(on)).toContain('网页遥控已连上，推杆区显示控台当前值');
    expect(on).not.toContain('<button');
  });
  it('网页遥控断了（C2）：正在自动重新登录是等待，标黄不标红、照旧给“连接网页遥控”；5 分钟到上限标红', () => {
    const draw = (footer: ReturnType<typeof ma2ConsoleFooter>): string => renderToStaticMarkup(React.createElement(Ma2ConsoleFooter, { footer, connecting: false, onConnect: () => Promise.resolve() }));
    const keys = { text: '按键：网页遥控', tone: 'normal' as const };
    const relogin = draw(ma2ConsoleFooter({ kind: 'relogin', attempt: 2 }, keys));
    expect(text(relogin)).toContain('网页遥控断了，正在自动重新登录（第 2 次）');
    expect(relogin).not.toContain('role="alert"'); expect(relogin).not.toContain('danger'); expect(relogin).toContain('data-tone="warning"'); expect(text(relogin)).toContain('连接网页遥控');
    const limit = draw(ma2ConsoleFooter({ kind: 'stopped', reason: '网页遥控断线 5 分钟还没能自动重新登录，请检查控台和网络后手动连接', limit: true }, keys));
    expect(limit).toContain('data-tone="danger"'); expect(limit).toContain('role="alert"');
    expect(text(limit)).toContain('网页遥控断线 5 分钟还没能自动重新登录，请检查控台和网络后手动连接');
    expect(text(limit)).toContain('连接网页遥控');
  });
});

describe('每一格（SSR）', () => {
  const base: Ma2ConsoleCell = { slot: 101, address: '1000.101', item: undefined, span: 1, live: { kind: 'none' }, timecode: false, key: { kind: 'idle' }, fader: null };
  const draw = (cell: Ma2ConsoleCell): string => renderToStaticMarkup(React.createElement(Ma2ConsoleCellStatus, { cell, faderReady: true, onFader: () => undefined }));
  it('按键失败红字只在这一格，在跑和当前 Cue 照读回写，推杆没读回时黄字', () => {
    expect(draw(base)).toBe('');
    const failed = draw({ ...base, key: { kind: 'failed', message: '按键操作已过期，没有补发，请重新点一次' } });
    expect(failed).toContain('data-tone="danger"'); expect(text(failed)).toBe('按键操作已过期，没有补发，请重新点一次');
    expect(text(draw({ ...base, live: { kind: 'live', running: true, cue: '3 副歌', stale: false } }))).toBe('3 副歌');
    expect(draw({ ...base, live: { kind: 'live', running: true, cue: '', stale: true } })).toContain('data-stale="true"');
    const late = draw({ ...base, fader: { value: 0.8, min: 0, max: 1, text: '20%', state: 'late', note: '控台还没显示这个值' } });
    expect(late).toContain('data-state="late"'); expect(text(late)).toBe('控台还没显示这个值');
    expect(late).not.toContain('disabled');
  });
});
