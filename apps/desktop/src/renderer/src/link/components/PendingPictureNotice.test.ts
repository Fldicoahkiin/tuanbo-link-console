import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdWhilePressed, PendingPictureNotice, shownWhilePressed, watchPointerPress, type HeldPress } from './PendingPictureNotice';

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);

describe('时间线上方那行提示', () => {
  it('联动台播放没拿着这首歌时不占位置', () => {
    expect(renderToStaticMarkup(React.createElement(PendingPictureNotice, { notice: null }))).toBe('');
  });

  it('用公共提示组件的单行样式，先写发生了什么，悬停能看到整句', () => {
    const notice = { tone: 'info', text: '播放中删了 1 处，正在送到 OBS', detail: '送到以前 OBS 照上一版播，删掉的 1 处也还在播。送到以后这一遍就按改过的播，不用停下重播。' } as const;
    const html = renderToStaticMarkup(React.createElement(PendingPictureNotice, { notice }));
    expect(html).toContain('<div class="timeline-pending-notice"><div class="ui-notice" data-tone="info" role="status" data-density="compact"');
    expect(html).toContain(`title="${notice.text}。${notice.detail}"`);
    expect(html).toContain(`<strong>${notice.text}</strong><div>${notice.detail}</div>`);
  });
});

describe('按住鼠标拖动、修剪时这行不增不减', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Presses on a window, and what `changed` heard so far. */
  function watched() {
    const target = new EventTarget(), heard: boolean[] = [];
    const stop = watchPointerPress(target, pressed => { heard.push(pressed); });
    return { target, heard, stop, fire: (type: string) => { target.dispatchEvent(new Event(type)); } };
  }

  /** The row's presence as the hold keeps it, while the song turns the notice on or off; wired as the component does. */
  function row(initially: boolean) {
    const target = new EventTarget();
    let value = initially, press: HeldPress = null;
    const stop = holdWhilePressed(target, () => value, next => { press = next(press); });
    return { stop, fire: (type: string) => { target.dispatchEvent(new Event(type)); }, song: (notice: boolean) => { value = notice; },
      shown: () => shownWhilePressed(press, value) };
  }

  it('评审场景：按下、拖放和松开都在捕获阶段听，时间线自己拦下冒泡（拖片段、拉宽音频行）也照样算；失去焦点只听窗口自己的', () => {
    const phases: Record<string, boolean> = {};
    const target = {
      addEventListener: (type: string, _listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        phases[type] = typeof options === 'object' ? options.capture === true : options === true;
      },
      removeEventListener: () => undefined
    };
    watchPointerPress(target, () => undefined);
    expect(phases).toEqual({ pointerdown: true, dragstart: true, pointerup: true, pointercancel: true, drop: true, dragend: true, blur: false });
  });

  it('按下时记住当时显示的样子；按住期间歌停了、再按下一个手指也不变；松开以后才跟着变', () => {
    const shown = row(true);
    shown.fire('pointerdown'); shown.song(false);
    expect(shown.shown()).toBe(true);
    shown.fire('pointerdown');
    expect(shown.shown()).toBe(true);
    shown.fire('pointerup');
    expect(shown.shown()).toBe(true);
    vi.runAllTimers();
    expect(shown.shown()).toBe(false);
    // Pressed while there is no row: no row until the press is over, though the song started meanwhile.
    shown.fire('pointerdown'); shown.song(true);
    expect(shown.shown()).toBe(false);
    shown.fire('pointerup'); vi.runAllTimers();
    expect(shown.shown()).toBe(true);
  });

  it('没在按的时候跟着歌变；停止监听以后不再按住', () => {
    const shown = row(false);
    shown.song(true); expect(shown.shown()).toBe(true);
    shown.stop(); shown.fire('pointerdown'); shown.song(false);
    expect(shown.shown()).toBe(false);
  });

  it('评审场景：松手时先让时间线按松手那一刻的轨道算出落点，这次松手的处理全部跑完以后才放开', async () => {
    const window = watched();
    // The timeline's own pointerup handler runs after the window's capture listener (useTimelineItemDrag.end):
    // the row must still be held while it works out the track under the pointer.
    const atDrop: boolean[][] = [];
    window.target.addEventListener('pointerup', () => { atDrop.push([...window.heard]); });
    window.fire('pointerdown'); window.fire('pointerup');
    expect(atDrop).toEqual([[true]]);
    // React commits in a microtask after the window's listener returns: still held then.
    await Promise.resolve();
    expect(window.heard).toEqual([true]);
    vi.runAllTimers();
    expect(window.heard).toEqual([true, false]);
  });

  it('松开后马上又按下（快速双击）：还没放开就接着按住，不放开', () => {
    const window = watched();
    window.fire('pointerdown'); window.fire('pointerup'); window.fire('pointerdown');
    vi.runAllTimers();
    expect(window.heard).not.toContain(false);
    window.fire('pointerup'); vi.runAllTimers();
    expect(window.heard.at(-1)).toBe(false);
  });

  it('取消按下同样等这次的处理跑完再放开；窗口失去焦点立即放开', () => {
    const window = watched();
    window.fire('pointerdown'); window.fire('pointercancel');
    expect(window.heard).toEqual([true]);
    vi.runAllTimers();
    expect(window.heard).toEqual([true, false]);
    window.fire('pointerdown'); window.fire('blur');
    expect(window.heard).toEqual([true, false, true, false]);
  });

  it('评审场景：从素材库拖素材（浏览器自己的拖放）会先取消按下，整个拖动期间照样按住，放下或拖动结束后才放开', () => {
    for (const ending of ['drop', 'dragend']) {
      const window = watched();
      // Chromium takes the pointer over for a native drag with a pointercancel.
      window.fire('pointerdown'); window.fire('dragstart'); window.fire('pointercancel');
      vi.runAllTimers();
      expect(window.heard).not.toContain(false);
      window.fire(ending);
      expect(window.heard).not.toContain(false);
      vi.runAllTimers();
      expect(window.heard.at(-1)).toBe(false);
    }
  });

  it('先取消按下、再开始拖动也一样按住', () => {
    const window = watched();
    window.fire('pointerdown'); window.fire('pointercancel'); window.fire('dragstart');
    vi.runAllTimers();
    expect(window.heard).not.toContain(false);
    window.fire('dragend'); vi.runAllTimers();
    expect(window.heard.at(-1)).toBe(false);
  });

  it('停止监听（这行提示卸载）以后，还没放开的那次不再通知，之后的按下、松开、拖动也不再算', () => {
    const window = watched();
    window.fire('pointerdown'); window.fire('pointerup');
    window.stop();
    vi.runAllTimers();
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'dragstart', 'drop', 'dragend', 'blur']) window.fire(type);
    vi.runAllTimers();
    expect(window.heard).toEqual([true]);
  });
});
