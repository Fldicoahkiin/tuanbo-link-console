import { describe, expect, it } from 'vitest';
import { routeKey, type RouteInput } from './key-route';
import { KEYMAP } from './keymap';
import {
  fixedReason, keyMarks, keyProblem, migrateV1, NO_CHANGES, parseKeySettings, serializeKeySettings, settingsKeymap, songKeyNote, songKeyProblem, stopAnywhere,
  stopKeyProblem, V1_DEFAULTS, withKeys, withStop
} from './key-settings';

/* K8 (04 设计 4.11): what a key the user sets may be. stores/shortcut-store.test.ts tests saving and moving them. */

const table = settingsKeymap(NO_CHANGES);

describe('随时停止的键（默认 Shift+Esc）', () => {
  it('要按住 Ctrl、Alt 或 Shift，或者是 F1–F12；不能是单个字母、数字、空格、Enter、Tab、Esc', () => {
    for (const chord of ['KeyA', 'Digit1', 'Space', 'Enter', 'Tab', 'Escape', 'Backquote']) expect(stopKeyProblem(table, chord), chord).not.toBeNull();
    for (const chord of ['F1', 'F12', 'Shift+F5', 'Ctrl+F12', 'Ctrl+Alt+KeyP', 'Alt+KeyP', 'Shift+Escape', 'Ctrl+Shift+KeyP']) expect(stopKeyProblem(table, chord), chord).toBeNull();
    // Shift with a key that types, or a key that edits in a field, would stop the show while typing.
    for (const chord of ['Shift+KeyA', 'Shift+Digit1', 'Shift+Space', 'Ctrl+ArrowLeft', 'Ctrl+Backspace', 'Shift+Enter', 'Ctrl+Tab']) expect(stopKeyProblem(table, chord), chord).not.toBeNull();
  });

  it('不能是系统组合（Alt+F4、Alt+Tab、Ctrl+Alt+Delete、Ctrl+Shift+Esc、带 Windows 键的）', () => {
    for (const chord of ['Alt+F4', 'Alt+Tab', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'Ctrl+Escape', 'Alt+Escape', 'Meta+KeyL', 'Ctrl+Meta+F1']) {
      expect(stopKeyProblem(table, chord), chord).toContain('Windows');
    }
  });

  it('不能和任何一页的任何键一样，也不能空着；改了以后每一页的停止都换成它，穿过所有层', () => {
    expect(stopKeyProblem(table, 'Ctrl+KeyS')).toContain('保存工程');
    expect(stopKeyProblem(table, 'Ctrl+KeyB')).toContain('在播放头分割');
    expect(stopKeyProblem(table, 'Ctrl+Shift+KeyB')).toContain('分割所有片段');
    expect(stopKeyProblem(table, 'Ctrl+KeyA')).toContain('全选');
    // A key the user gave a command counts too.
    const moved = settingsKeymap(withKeys(NO_CHANGES, 'timeline', 'view.zoomFit', ['F9']));
    expect(stopKeyProblem(moved, 'F9')).toContain('缩放到合适');
    expect(stopKeyProblem(table, '')).not.toBeNull();
    const keymap = settingsKeymap(withStop(NO_CHANGES, 'F8'));
    expect(stopAnywhere(keymap)).toBe('F8');
    expect(keymap.filter(entry => entry.id === 'transport.stop').map(entry => entry.keys)).toEqual([
      [{ chord: 'Escape', switch: 'plainEscapeStops' }, { chord: 'F8', through: 'all' }], [{ chord: 'Escape', switch: 'plainEscapeStops' }, { chord: 'F8', through: 'all' }]]);
    const input = (chord: string, more: Partial<RouteInput>): RouteInput => ({ chord, repeat: false, composing: false, owner: null, inTimeline: false, modalOpen: false,
      overlays: [], drag: 'none', page: 'project', keymap, available: () => true, song: () => undefined, ...more });
    for (const page of ['project', 'cues', 'lighting'] as const) {
      for (const where of [{ owner: 'field' as const }, { modalOpen: true }, { drag: 'active' as const }, { inTimeline: true }]) {
        expect(routeKey(input('F8', { page, ...where }))).toMatchObject({ kind: 'run', id: 'transport.stop' });
      }
      expect(routeKey(input('Shift+Escape', { page, owner: 'field' }))).toEqual({ kind: 'native' });
    }
  });
});

describe('改别的键', () => {
  it('表里的默认键彼此不撞：每个能改的键都过得了检查', () => {
    for (const entry of KEYMAP.filter(item => item.rebindable)) {
      expect(keyProblem(table, entry.scope, entry.id, entry.keys.map(binding => binding.chord)), `${entry.scope} ${entry.id}`).toBeNull();
    }
    expect(keyMarks(NO_CHANGES)).toEqual({ commands: new Map(), stop: null });
  });

  it('不能改的项都写了一句原因', () => {
    for (const entry of KEYMAP) expect(fixedReason(entry) === null, `${entry.scope} ${entry.id}`).toBe(entry.rebindable);
  });

  it('存的格式：只有改过的；读的时候认不出的就报错', () => {
    const settings = withStop(withKeys(withKeys(NO_CHANGES, 'editor', 'marker.add', ['KeyJ']), 'editor', 'marker.add', ['KeyM']), 'Ctrl+F1');
    expect(JSON.parse(serializeKeySettings(settings))).toEqual({ version: 1, keys: {}, stop: 'Ctrl+F1' });
    const changed = withKeys(settings, 'timeline', 'edit.split', ['KeyX']);
    expect(parseKeySettings(serializeKeySettings(changed))).toEqual(changed);
    expect(() => parseKeySettings('{"version":1,"keys":{"timeline":{"edit.split":["Shift+Ctrl+KeyX"]}}}')).toThrow();
    expect(() => parseKeySettings('{"version":1,"keys":{"global":{"document.save":["KeyX"]}}}')).not.toThrow();
    expect(parseKeySettings('{"version":1,"keys":{"global":{"document.save":["KeyX"]}}}')).toEqual(NO_CHANGES);
    expect(() => parseKeySettings('{"version":1,"keys":{"lighting":{"edit.delete":["KeyX"]}}}')).toThrow('不是能改的键');
  });

  it('旧格式搬过来：默认的不写', () => {
    expect(migrateV1(JSON.stringify(V1_DEFAULTS))).toEqual(NO_CHANGES);
    expect(() => migrateV1(JSON.stringify([...V1_DEFAULTS, { id: 'twice', action: 'end', key: 'KeyM' }]))).toThrow('同一个键');
  });
});

describe('歌曲自己的快捷键', () => {
  it('停止键、系统组合和工程的键拒绝', () => {
    expect(songKeyProblem(table, 'Escape')).toContain('停止键');
    expect(songKeyProblem(table, 'Shift+Escape')).toContain('停止键');
    expect(songKeyProblem(settingsKeymap(withStop(NO_CHANGES, 'F8')), 'F8')).toContain('停止键');
    expect(songKeyProblem(table, 'Alt+F4')).toContain('Windows');
    expect(songKeyProblem(table, 'Ctrl+KeyS')).toContain('保存工程');
    expect(songKeyProblem(table, 'Digit1')).toBeNull();
    expect(songKeyProblem(table, 'KeyM')).toBeNull();
  });

  it('是编辑器或灯光工作台的键只提醒一句：在那一页按它不会播这首歌', () => {
    expect(songKeyNote(table, 'KeyM')).toBe('M 在编辑器里是「在播放头加标记」，在灯光工作台里是「在播放头打点」，在那两页按它不会播这首歌。');
    expect(songKeyNote(table, 'KeyQ')).toBeNull();
    expect(songKeyNote(settingsKeymap(withKeys(NO_CHANGES, 'lighting', 'lighting.stamp', ['KeyJ'])), 'KeyJ')).toBe('在灯光工作台里，J 是「在播放头打点」，在那一页按它不会播这首歌。');
    expect(songKeyNote(table, 'Ctrl+KeyC')).toBe('在编辑器和灯光工作台里，Ctrl+C 是「复制灯光点」，在那两页按它不会播这首歌。');
    expect(songKeyNote(table, 'Digit1')).toBeNull();
    // The timeline's own keys take them only with the focus in the timeline, where a song never plays anyway.
    expect(songKeyNote(table, 'Ctrl+KeyB')).toBeNull();
  });
});
