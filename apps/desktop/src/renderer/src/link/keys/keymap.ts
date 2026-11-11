import type { KeyChord } from './key-chord';

/*
 * The one table of the app's keys: what each key does, on which page, and how it gets past the fields, dialogs and
 * buttons in its way. Written as the keys are today (0.5.9: Escape stops, S splits, Shift+←/→ moves a second); the
 * key router (key-router.ts) acts on every key in it: the window's (K3), and the timeline's, the lighting points' and
 * the lighting workbench's shortcut keys (K6). The pages register what each command does there (useKeyCommands).
 */

/**
 * Where a key works:
 * - `global`: the whole window (useInternalPlayer, useDocumentShortcuts);
 * - `editor`: the editor page (ReferenceTimeline's keys there, and LightingTimeline's M);
 * - `lighting`: the lighting workbench (its shortcut keys, useTimelineStamp, which the user can change; the Cue
 *   points' Delete and Escape, WaveformCuePoints);
 * - `timeline`: the timeline of the editor and of the lighting workbench (ReferenceTimeline);
 * - `lighting-points`: the lighting points on both pages, wherever the focus is (LightingTimeline). Copy, paste and
 *   delete are the timeline's in it and theirs elsewhere; which clipboard and which selection they take is decided in
 *   one place (components/timeline-commands.ts, 04 设计 3.3 b, d);
 * - `home`: the home page. No key of its own in the table: its handlers act for the window's keys there (the player's
 *   play button for Space, the program list's Escape), see key-router.ts.
 */
export type KeyScope = 'global' | 'home' | 'editor' | 'lighting' | 'timeline' | 'lighting-points';
/** The page on screen (LinkApp). */
export type KeyPage = 'project' | 'cues' | 'lighting';

/** The page's scopes in the order they are asked, before the window's (`global`). */
export const PAGE_SCOPES: Readonly<Record<KeyPage, readonly KeyScope[]>> = {
  project: [],
  cues: ['editor', 'timeline', 'lighting-points'],
  lighting: ['lighting', 'timeline', 'lighting-points']
};

export type CommandId =
  | 'transport.stop' | 'transport.playPause' | 'transport.prevFrame' | 'transport.nextFrame' | 'transport.backMany' | 'transport.forwardMany'
  | 'transport.start' | 'transport.end'
  | 'home.prevSong' | 'home.nextSong'
  | 'edit.split' | 'edit.delete' | 'edit.copy' | 'edit.cut' | 'edit.paste' | 'edit.duplicate' | 'edit.selectAll' | 'edit.deselect'
  | 'lighting.stamp' | 'lighting.addPoint'
  | 'document.save' | 'document.saveAs' | 'document.undo' | 'document.redo';

/**
 * How far a key gets past what keeps keys: `fields` past fields that type or pick; `dialogs` past those and open
 * dialogs too; `all` past every layer, drags and overlays included, but not a field that records keys.
 */
export type KeyThrough = 'fields' | 'dialogs' | 'all';

/**
 * A switch on this computer that turns one key of a command off. `plainEscapeStops`: 「单按 Esc 停止」, which the
 * settings can turn off (00-order 第 8 节第 1 题). Not in the settings yet; while it is not, every switch is on.
 */
export type KeySwitch = 'plainEscapeStops';

/**
 * One key of a command. A command can have several, each getting past the layers its own way: the stop command will
 * have Escape, which takes its turn after fields, dialogs and drags and can be switched off, and Shift+Escape, which
 * gets through everything (`through: 'all'`, 00-order 第 8 节第 1 题, K7). Today it has Escape only.
 */
export type KeyBinding = { chord: KeyChord; through?: KeyThrough; switch?: KeySwitch };

export type KeyEntry = {
  id: CommandId;
  scope: KeyScope;
  /** The first is the one shown. */
  keys: readonly KeyBinding[];
  /** The name in the settings and in hints. */
  label: string;
  group: '播放' | '定位' | '剪辑' | '视图' | '标记' | '灯光' | '工程';
  kind: 'transport' | 'edit' | 'view' | 'document';
  /** Held down: `once` acts on the first press only, `repeat` on every repeat. */
  repeat: 'once' | 'repeat';
  /** `timeline`: only with the focus in the timeline; `outside-timeline`: only outside it, where the timeline does not take its own keys. */
  area?: 'timeline' | 'outside-timeline';
  /**
   * With a button focused: `take` acts there too (Space presses the page's play button, not the focused one); `items`
   * acts on the timeline's own buttons (clips, Cues, waveforms) and leaves the others; `leave` leaves every button.
   */
  buttons: 'take' | 'items' | 'leave';
  /** What 剪映专业版 calls it and its keys there (04 设计第 6 节, to be checked on the 剪映 at the venue); null when 剪映 has none. */
  jianying: { name: string; keys: readonly KeyChord[] } | null;
  /** Why the keys are not 剪映's, wherever they are not. */
  differsFromJianying?: string;
  /** Whether the user can change it in the settings. */
  rebindable: boolean;
};

const key = (chord: KeyChord, more: Omit<KeyBinding, 'chord'> = {}): KeyBinding => ({ chord, ...more });

export const KEYMAP: readonly KeyEntry[] = [
  // The window (useInternalPlayer, the page's play button): outside the timeline, which takes its own keys.
  { id: 'transport.playPause', scope: 'global', keys: [key('Space')], label: '播放 / 暂停（按当前页面的播放按钮）', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', buttons: 'take', jianying: { name: '播放/暂停', keys: ['Space'] }, rebindable: false },
  { id: 'transport.stop', scope: 'global', keys: [key('Escape', { switch: 'plainEscapeStops' })], label: '停止', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', buttons: 'leave', jianying: null, rebindable: false },
  { id: 'home.prevSong', scope: 'global', keys: [key('ArrowUp')], label: '上一首（开了「方向键切歌」时）', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', buttons: 'leave', jianying: null, rebindable: false },
  { id: 'home.nextSong', scope: 'global', keys: [key('ArrowDown')], label: '下一首（开了「方向键切歌」时）', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', buttons: 'leave', jianying: null, rebindable: false },
  // useDocumentShortcuts: saving works in fields and dialogs too; undo and redo leave fields and dialogs.
  { id: 'document.save', scope: 'global', keys: [key('Ctrl+KeyS', { through: 'dialogs' })], label: '保存工程', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: null, rebindable: false },
  { id: 'document.saveAs', scope: 'global', keys: [key('Ctrl+Shift+KeyS', { through: 'dialogs' })], label: '另存为', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: null, rebindable: false },
  { id: 'document.undo', scope: 'global', keys: [key('Ctrl+KeyZ')], label: '撤销', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: { name: '撤销', keys: ['Ctrl+KeyZ'] }, rebindable: false },
  { id: 'document.redo', scope: 'global', keys: [key('Ctrl+KeyY'), key('Ctrl+Shift+KeyZ')], label: '重做', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: { name: '恢复', keys: ['Ctrl+Shift+KeyZ'] }, differsFromJianying: 'Ctrl+Y 是联动台原有的键，排在前面', rebindable: false },

  // The editor's timeline (ReferenceTimeline: handleTimelineTransportKey, handleTimelineEditKey).
  { id: 'transport.playPause', scope: 'editor', keys: [key('Space')], label: '播放 / 暂停', group: '播放', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: { name: '播放/暂停', keys: ['Space'] }, rebindable: false },
  { id: 'transport.start', scope: 'editor', keys: [key('Home')], label: '回到开头', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '跳到开头', keys: ['Home'] }, rebindable: false },
  { id: 'transport.prevFrame', scope: 'editor', keys: [key('ArrowLeft')], label: '后退一帧', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '上一帧', keys: ['ArrowLeft'] }, rebindable: false },
  { id: 'transport.nextFrame', scope: 'editor', keys: [key('ArrowRight')], label: '前进一帧', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '下一帧', keys: ['ArrowRight'] }, rebindable: false },
  { id: 'transport.backMany', scope: 'editor', keys: [key('Shift+ArrowLeft')], label: '后退一秒', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '后退多帧', keys: ['Shift+ArrowLeft'] }, differsFromJianying: '键一样；剪映退几帧，联动台现在退一秒', rebindable: false },
  { id: 'transport.forwardMany', scope: 'editor', keys: [key('Shift+ArrowRight')], label: '前进一秒', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '前进多帧', keys: ['Shift+ArrowRight'] }, differsFromJianying: '键一样；剪映进几帧，联动台现在进一秒', rebindable: false },
  // LightingTimeline's window keys, in the editor only.
  { id: 'lighting.addPoint', scope: 'editor', keys: [key('KeyM')], label: '在播放位置加灯光点', group: '灯光', kind: 'edit', repeat: 'once',
    buttons: 'take', jianying: { name: '添加标记', keys: ['KeyM'] }, differsFromJianying: '键一样；剪映的 M 加标记，编辑器现在的 M 在灯光轨道上加灯光点', rebindable: false },

  // The lighting workbench's shortcut keys (useTimelineStamp → handleLightingShortcut): the whole page, the user can change them.
  { id: 'lighting.stamp', scope: 'lighting', keys: [key('KeyM')], label: '在播放头打点', group: '灯光', kind: 'edit', repeat: 'once',
    buttons: 'leave', jianying: { name: '添加标记', keys: ['KeyM'] }, differsFromJianying: '键一样；灯光工作台的打点相当于剪映的标记', rebindable: true },
  { id: 'transport.playPause', scope: 'lighting', keys: [key('Space')], label: '播放 / 暂停', group: '播放', kind: 'transport', repeat: 'once',
    buttons: 'take', jianying: { name: '播放/暂停', keys: ['Space'] }, rebindable: true },
  { id: 'transport.prevFrame', scope: 'lighting', keys: [key('ArrowLeft')], label: '后退一帧', group: '定位', kind: 'transport', repeat: 'once',
    buttons: 'leave', jianying: { name: '上一帧', keys: ['ArrowLeft'] }, rebindable: true },
  { id: 'transport.nextFrame', scope: 'lighting', keys: [key('ArrowRight')], label: '前进一帧', group: '定位', kind: 'transport', repeat: 'once',
    buttons: 'leave', jianying: { name: '下一帧', keys: ['ArrowRight'] }, rebindable: true },
  { id: 'transport.start', scope: 'lighting', keys: [key('Home')], label: '回到开头', group: '定位', kind: 'transport', repeat: 'once',
    buttons: 'leave', jianying: { name: '跳到开头', keys: ['Home'] }, rebindable: true },
  { id: 'transport.end', scope: 'lighting', keys: [key('End')], label: '跳到结尾', group: '定位', kind: 'transport', repeat: 'once',
    buttons: 'leave', jianying: { name: '跳到结尾', keys: ['End'] }, rebindable: true },
  // The lighting workbench's Cue points (WaveformCuePoints), asked before the timeline: with Cue points selected Delete
  // and Backspace delete them, with none selected the focused one; Escape in the Cue points clears the selection and
  // does not stop the show (2026-09-21). They take these keys only there (the registration's `when`).
  { id: 'edit.delete', scope: 'lighting', keys: [key('Delete'), key('Backspace')], label: '删除选中的 Cue 点', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: { name: '删除', keys: ['Delete', 'Backspace'] }, rebindable: false },
  { id: 'edit.deselect', scope: 'lighting', keys: [key('Escape')], label: '取消选择 Cue 点', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: null, rebindable: false },

  // The timeline on both pages (ReferenceTimeline): Escape stops and goes no further; the editing keys leave buttons other than clips and Cues.
  { id: 'transport.stop', scope: 'timeline', keys: [key('Escape', { switch: 'plainEscapeStops' })], label: '停止', group: '播放', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: null, rebindable: false },
  { id: 'edit.copy', scope: 'timeline', keys: [key('Ctrl+KeyC')], label: '复制片段或 Cue', group: '剪辑', kind: 'edit', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '复制', keys: ['Ctrl+KeyC'] }, rebindable: false },
  { id: 'edit.paste', scope: 'timeline', keys: [key('Ctrl+KeyV')], label: '粘贴到播放头', group: '剪辑', kind: 'edit', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '粘贴', keys: ['Ctrl+KeyV'] }, rebindable: false },
  { id: 'edit.duplicate', scope: 'timeline', keys: [key('Ctrl+KeyD')], label: '在后方创建副本', group: '剪辑', kind: 'edit', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '复制片段（待核对）', keys: ['Ctrl+KeyD'] }, rebindable: false },
  { id: 'edit.split', scope: 'timeline', keys: [key('KeyS')], label: '在播放头分割', group: '剪辑', kind: 'edit', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '分割', keys: ['Ctrl+KeyB'] }, differsFromJianying: '0.5.9 的 S，第 7 题切到剪映的 Ctrl+B 时改（K7）', rebindable: false },
  { id: 'edit.delete', scope: 'timeline', keys: [key('Delete')], label: '删除', group: '剪辑', kind: 'edit', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '删除', keys: ['Delete', 'Backspace'] }, differsFromJianying: 'Backspace 现在只删灯光点（lighting-points）', rebindable: false },

  // The lighting points (LightingTimeline's window keys): on both pages, wherever the focus is but in fields and dialogs.
  { id: 'edit.selectAll', scope: 'lighting-points', keys: [key('Ctrl+KeyA')], label: '全选这个片段里的灯光点', group: '剪辑', kind: 'edit', repeat: 'once',
    buttons: 'take', jianying: { name: '全选', keys: ['Ctrl+KeyA'] }, rebindable: false },
  { id: 'edit.copy', scope: 'lighting-points', keys: [key('Ctrl+KeyC')], label: '复制灯光点', group: '剪辑', kind: 'edit', repeat: 'once',
    buttons: 'take', jianying: { name: '复制', keys: ['Ctrl+KeyC'] }, rebindable: false },
  { id: 'edit.cut', scope: 'lighting-points', keys: [key('Ctrl+KeyX')], label: '剪切灯光点', group: '剪辑', kind: 'edit', repeat: 'once',
    buttons: 'take', jianying: { name: '剪切', keys: ['Ctrl+KeyX'] }, rebindable: false },
  { id: 'edit.paste', scope: 'lighting-points', keys: [key('Ctrl+KeyV')], label: '粘贴灯光点', group: '剪辑', kind: 'edit', repeat: 'once',
    buttons: 'take', jianying: { name: '粘贴', keys: ['Ctrl+KeyV'] }, rebindable: false },
  { id: 'edit.delete', scope: 'lighting-points', keys: [key('Delete'), key('Backspace')], label: '删除灯光点', group: '剪辑', kind: 'edit', repeat: 'once',
    buttons: 'take', jianying: { name: '删除', keys: ['Delete', 'Backspace'] }, rebindable: false }
];

/** Keys the user changed on this computer, by scope and command; a command left out keeps its keys from the table. */
export type KeyOverrides = Partial<Record<KeyScope, Partial<Record<CommandId, readonly KeyChord[]>>>>;

/**
 * The table with the user's keys (`overrides`) in place of the table's, for the commands the user can change
 * (`rebindable`). A command overridden with no key has none: no key presses it.
 */
export function resolveKeymap(keymap: readonly KeyEntry[], overrides: KeyOverrides): readonly KeyEntry[] {
  return keymap.map(entry => {
    const chords = entry.rebindable ? overrides[entry.scope]?.[entry.id] : undefined;
    return chords === undefined ? entry : { ...entry, keys: chords.map(chord => key(chord)) };
  });
}
