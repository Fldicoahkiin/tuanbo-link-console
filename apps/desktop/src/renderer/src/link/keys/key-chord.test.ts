import { expect, it } from 'vitest';
import { readV1, V1_DEFAULTS } from './key-settings';
import { chordLabel, chordOf, isSystemChord, parseChord } from './key-chord';

type Press = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };
const press = (code: string, modifiers: Partial<Omit<Press, 'code'>> = {}): Press => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });

/** The three ways a chord was spelt before key-chord.ts, copied as they were (0.5.9). */
const spelt = {
  /** 0.5.8 stores/shortcut-store.ts `shortcutKey`: the lighting shortcuts, with Meta. */
  lighting: (event: Press) => [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), ...(event.metaKey ? ['Meta'] : []), event.code].join('+'),
  /** playback-keys.ts `playbackKeyAction`: a song's shortcut looked up, without Meta. */
  window: (event: Press) => [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), event.code].join('+'),
  /** SongPlaybackProperties.tsx: a song's shortcut recorded, without Meta. */
  song: (event: Press) => [...(event.ctrlKey ? ['Ctrl'] : []), ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), event.code].join('+')
};

/** Every modifier combination on a few keys. */
const presses = (): Press[] => ['KeyM', 'Digit3', 'Space', 'ArrowLeft', 'F5', 'Equal', 'Escape'].flatMap(code =>
  Array.from({ length: 16 }, (_, bits) => press(code, { ctrlKey: (bits & 1) !== 0, altKey: (bits & 2) !== 0, shiftKey: (bits & 4) !== 0, metaKey: (bits & 8) !== 0 })));

it('按键组合只有一种拼法：三种旧拼法得到的字符串都和 chordOf 一样（灯光快捷键带 Meta，歌曲快捷键不带 Meta）', () => {
  for (const event of presses()) {
    expect(chordOf(event)).toBe(spelt.lighting(event));
    expect(chordOf(event, { meta: false })).toBe(spelt.window(event));
    expect(chordOf(event, { meta: false })).toBe(spelt.song(event));
  }
});

it('已经存下的灯光快捷键和歌曲快捷键照样认：存的字符串就是 chordOf 的结果，能原样拆开', () => {
  // Saved by 0.5.8 and 0.5.9 in tblink.timeline-shortcuts.
  const saved = readV1([...V1_DEFAULTS, { id: 'extra', action: 'stamp', key: 'Shift+KeyM' }]);
  expect(saved.map(binding => binding.key)).toEqual(['KeyM', 'Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Shift+KeyM']);
  expect(saved.find(binding => binding.key === chordOf(press('KeyM', { shiftKey: true })))?.action).toBe('stamp');
  expect(saved.find(binding => binding.key === chordOf(press('ArrowLeft')))?.action).toBe('previous');
  // A song's playback.shortcut as SongPlaybackProperties saved it.
  for (const shortcut of ['Ctrl+Digit3', 'Ctrl+Alt+Shift+KeyQ', 'F5', 'Shift+Space']) {
    const parsed = parseChord(shortcut);
    expect(parsed).not.toBeNull();
    expect(chordOf({ code: parsed!.code, ctrlKey: parsed!.ctrl, altKey: parsed!.alt, shiftKey: parsed!.shift, metaKey: parsed!.meta }, { meta: false })).toBe(shortcut);
  }
  // Meta held: a song is never recorded with it, a lighting key is.
  expect(chordOf(press('KeyK', { metaKey: true }), { meta: false })).toBe('KeyK');
  expect(chordOf(press('KeyK', { metaKey: true }))).toBe('Meta+KeyK');
  expect(parseChord('Meta+KeyK')).toEqual({ ctrl: false, alt: false, shift: false, meta: true, code: 'KeyK' });
});

it('拼法不对的字符串拆不开：修饰键顺序乱了、只有修饰键、空的', () => {
  for (const chord of ['Shift+Ctrl+KeyA', 'Ctrl', 'Ctrl+Shift', '', 'Ctrl+']) expect(parseChord(chord)).toBeNull();
  expect(parseChord('Ctrl+Alt+Shift+Meta+KeyA')).toEqual({ ctrl: true, alt: true, shift: true, meta: true, code: 'KeyA' });
});

it('键名按人读的写：空格、方向键、F 键、Ctrl+=、Esc，字母和数字去掉 Key/Digit', () => {
  expect(chordLabel('Space')).toBe('空格');
  expect(chordLabel('Shift+Space')).toBe('Shift+空格');
  expect(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].map(chordLabel)).toEqual(['←', '→', '↑', '↓']);
  expect(chordLabel('Shift+ArrowLeft')).toBe('Shift+←');
  expect(['F1', 'F5', 'F12', 'Shift+F10'].map(chordLabel)).toEqual(['F1', 'F5', 'F12', 'Shift+F10']);
  expect(chordLabel('Ctrl+Equal')).toBe('Ctrl+=');
  expect(chordLabel('Ctrl+Minus')).toBe('Ctrl+-');
  expect(chordLabel('Shift+Escape')).toBe('Shift+Esc');
  expect(chordLabel('Ctrl+KeyB')).toBe('Ctrl+B');
  expect(chordLabel('Ctrl+Digit3')).toBe('Ctrl+3');
  expect(chordLabel('Home')).toBe('Home');
  expect(['KeyM', 'Space', 'Shift+KeyK', 'Digit7'].map(chordLabel)).toEqual(['M', '空格', 'Shift+K', '7']);
});

it('Windows 和输入法自己用的组合不能当快捷键：开始菜单、切窗口、任务管理器、关窗口、中英文切换、带 Windows 键的', () => {
  for (const chord of ['Ctrl+Escape', 'Alt+Escape', 'Ctrl+Shift+Escape', 'Alt+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Space', 'Meta+KeyD', 'Shift+Meta+KeyS', 'Meta+Escape']) {
    expect(isSystemChord(chord)).toBe(true);
  }
  for (const chord of ['Escape', 'Shift+Escape', 'Space', 'KeyM', 'Ctrl+KeyS', 'Ctrl+Equal', 'F5', 'Shift+Space']) expect(isSystemChord(chord)).toBe(false);
});
