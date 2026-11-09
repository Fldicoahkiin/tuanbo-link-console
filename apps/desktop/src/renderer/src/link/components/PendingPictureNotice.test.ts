import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { nextPress, PendingPictureNotice, watchPointerPress } from './PendingPictureNotice';

// The renderer's TSX compiles to React.createElement here.
vi.stubGlobal('React', React);

describe('时间线上方那行提示', () => {
  it('联动台播放没拿着这首歌时不占位置', () => {
    expect(renderToStaticMarkup(React.createElement(PendingPictureNotice, { notice: null }))).toBe('');
  });

  it('用公共提示组件的单行样式，先写发生了什么，悬停能看到整句', () => {
    const notice = { tone: 'warning', text: '播放中删了 1 处，停下重播才生效', detail: 'OBS 还在按开始播放时的时间线播，删掉的 1 处也照常播出。' } as const;
    const html = renderToStaticMarkup(React.createElement(PendingPictureNotice, { notice }));
    expect(html).toContain('<div class="timeline-pending-notice"><div class="ui-notice" data-tone="warning" role="status" data-density="compact"');
    expect(html).toContain(`title="${notice.text}。${notice.detail}"`);
    expect(html).toContain(`<strong>${notice.text}</strong><div>${notice.detail}</div>`);
  });
});

describe('按住鼠标拖动、修剪时这行不增不减', () => {
  it('按下时记住当时显示的样子，再按一个键也不变，松开才放开', () => {
    const held = nextPress(null, true, true);
    expect(held).toEqual({ value: true });
    // The song stopped while the part is still held: the row stays, and a second button changes nothing.
    expect(nextPress(held, true, false)).toBe(held);
    expect(nextPress(held, false, false)).toBeNull();
    expect(nextPress(null, true, false)).toEqual({ value: false });
  });

  it('窗口里任何地方按下、松开、取消或窗口失去焦点都算数，停止监听后不再算', () => {
    const target = new EventTarget(), changed = vi.fn<(pressed: boolean) => void>();
    const stop = watchPointerPress(target, changed);
    for (const type of ['pointerdown', 'pointerup', 'pointerdown', 'pointercancel', 'pointerdown', 'blur']) target.dispatchEvent(new Event(type));
    expect(changed.mock.calls.map(([pressed]) => pressed)).toEqual([true, false, true, false, true, false]);
    stop();
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'blur']) target.dispatchEvent(new Event(type));
    expect(changed).toHaveBeenCalledTimes(6);
  });
});
