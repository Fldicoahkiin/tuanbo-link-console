import type { KeyChord } from './key-chord';

/*
 * The one table of the app's keys: what each key does, on which page, and how it gets past the fields, dialogs and
 * buttons in its way. The key router (key-router.ts) acts on every key in it; the pages register what each command
 * does there (useKeyCommands).
 *
 * Since K7 the editor's and the lighting workbench's keys are 剪映专业版's defaults (第 7 题, 04 设计第 5、6 节): Ctrl+B
 * splits, Q/W trim to the playhead, ↑↓ go to the edit points, N turns snapping on and off, M adds a marker in the
 * editor. The home page keeps its keys. Escape still stops the show, after fields, dialogs, drags and the page have had
 * their turn, and Shift+Escape stops it from anywhere (00-order 第 8 节第 1 题, which replaces 04 设计 4.10's “Escape no
 * longer stops”); the settings can turn the plain Escape off (`plainEscapeStops`).
 *
 * Since K8 the user can change the keys marked `rebindable` and the stop key that gets through everything; what a key
 * may be and when two commands clash is decided in keys/key-settings.ts, and `resolveKeymap` puts the changes in.
 */

/**
 * Where a key works:
 * - `global`: the whole window (useInternalPlayer, useDocumentShortcuts);
 * - `editor`: the editor page (ReferenceTimeline's keys there, and LightingTimeline's marker key);
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
  | 'transport.stop' | 'transport.playPause' | 'transport.pause' | 'transport.play'
  | 'transport.prevFrame' | 'transport.nextFrame' | 'transport.backMany' | 'transport.forwardMany'
  | 'transport.start' | 'transport.end' | 'transport.prevEditPoint' | 'transport.nextEditPoint'
  | 'home.prevSong' | 'home.nextSong'
  | 'edit.split' | 'edit.splitAll' | 'edit.trimLeft' | 'edit.trimRight' | 'edit.delete' | 'edit.copy' | 'edit.cut' | 'edit.paste'
  | 'edit.duplicate' | 'edit.selectAll' | 'edit.deselect' | 'edit.splitMoved'
  | 'view.snap' | 'view.zoomIn' | 'view.zoomOut' | 'view.zoomFit'
  | 'marker.add'
  | 'lighting.stamp'
  | 'document.save' | 'document.saveAs' | 'document.undo' | 'document.redo';

/**
 * How far a key gets past what keeps keys: `fields` past fields that type or pick; `dialogs` past those and open
 * dialogs too; `all` past every layer, drags and overlays included, but not a field that records keys.
 */
export type KeyThrough = 'fields' | 'dialogs' | 'all';

/**
 * A switch on this computer that turns one key of a command off. `plainEscapeStops`: 「单按 Esc 停止」 (settings →
 * 快捷键, stores/shortcut-store.ts), on unless turned off (00-order 第 8 节第 1 题).
 */
export type KeySwitch = 'plainEscapeStops';

/**
 * One key of a command. A command can have several, each getting past the layers its own way: the stop command has
 * Escape, which takes its turn after fields, dialogs, drags and the page and can be switched off, and Shift+Escape,
 * which gets through everything (`through: 'all'`). `switch`: the key works unless that switch is turned off;
 * `whileOff`: only while it is (the timeline's Escape clears the selection once 「单按 Esc 停止」 is off).
 */
export type KeyBinding = { chord: KeyChord; through?: KeyThrough; switch?: KeySwitch; whileOff?: KeySwitch };

/** Whether `binding` works with `switchesOff` turned off on this computer. */
export function bindingWorks(binding: KeyBinding, switchesOff: ReadonlySet<KeySwitch>): boolean {
  return (binding.switch === undefined || !switchesOff.has(binding.switch)) && (binding.whileOff === undefined || switchesOff.has(binding.whileOff));
}

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
  /** Only on these pages; every page when left out. */
  pages?: readonly KeyPage[];
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
/** The stop command's keys, the same on every page (00-order 第 8 节第 1 题). */
const STOP_KEYS: readonly KeyBinding[] = [key('Escape', { switch: 'plainEscapeStops' }), key('Shift+Escape', { through: 'all' })];

export const KEYMAP: readonly KeyEntry[] = [
  // The window (useInternalPlayer, the page's play button): outside the timeline, which takes its own keys.
  { id: 'transport.playPause', scope: 'global', keys: [key('Space')], label: '播放 / 暂停（按当前页面的播放按钮）', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', buttons: 'take', jianying: { name: '播放/暂停', keys: ['Space'] }, rebindable: false },
  // Stop, outside the timeline (which has its own, below): the page's stop where the page has one (the editor's and the
  // lighting workbench's stop the MA2 audition and the lighting preview too, key-router.ts HANDLER_SCOPES), the
  // player's elsewhere. Escape leaves buttons and fields their key; Shift+Escape not.
  { id: 'transport.stop', scope: 'global', keys: STOP_KEYS, label: '停止', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', buttons: 'leave', jianying: null, rebindable: false },
  // The previous and next song on the home page only (第 7 题): on the editor and the lighting workbench ↑↓ go to the edit points.
  { id: 'home.prevSong', scope: 'global', keys: [key('ArrowUp')], label: '上一首（开了「方向键切歌」时）', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', pages: ['project'], buttons: 'leave', jianying: null, rebindable: false },
  { id: 'home.nextSong', scope: 'global', keys: [key('ArrowDown')], label: '下一首（开了「方向键切歌」时）', group: '播放', kind: 'transport', repeat: 'once',
    area: 'outside-timeline', pages: ['project'], buttons: 'leave', jianying: null, rebindable: false },
  // useDocumentShortcuts: saving works in fields and dialogs too; undo and redo leave fields and dialogs.
  { id: 'document.save', scope: 'global', keys: [key('Ctrl+KeyS', { through: 'dialogs' })], label: '保存工程', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: null, rebindable: false },
  { id: 'document.saveAs', scope: 'global', keys: [key('Ctrl+Shift+KeyS', { through: 'dialogs' })], label: '另存为', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: null, rebindable: false },
  { id: 'document.undo', scope: 'global', keys: [key('Ctrl+KeyZ')], label: '撤销', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: { name: '撤销', keys: ['Ctrl+KeyZ'] }, rebindable: false },
  { id: 'document.redo', scope: 'global', keys: [key('Ctrl+KeyY'), key('Ctrl+Shift+KeyZ')], label: '重做', group: '工程', kind: 'document', repeat: 'repeat',
    buttons: 'take', jianying: { name: '恢复', keys: ['Ctrl+Shift+KeyZ'] }, differsFromJianying: 'Ctrl+Y 是联动台原有的键，排在前面', rebindable: false },

  // The editor's timeline (ReferenceTimeline, editorTransportKeys and the editor's edit keys).
  { id: 'transport.playPause', scope: 'editor', keys: [key('Space')], label: '播放 / 暂停', group: '播放', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: { name: '播放/暂停', keys: ['Space'] }, rebindable: false },
  { id: 'transport.start', scope: 'editor', keys: [key('Home')], label: '回到开头', group: '定位', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '跳到开头', keys: ['Home'] }, rebindable: true },
  { id: 'transport.end', scope: 'editor', keys: [key('End')], label: '跳到结尾', group: '定位', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '跳到结尾', keys: ['End'] }, rebindable: true },
  { id: 'transport.prevFrame', scope: 'editor', keys: [key('ArrowLeft')], label: '后退一帧', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '上一帧', keys: ['ArrowLeft'] }, rebindable: true },
  { id: 'transport.nextFrame', scope: 'editor', keys: [key('ArrowRight')], label: '前进一帧', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '下一帧', keys: ['ArrowRight'] }, rebindable: true },
  { id: 'edit.splitAll', scope: 'editor', keys: [key('Ctrl+Shift+KeyB')], label: '在播放头分割所有片段', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '全部分割（待核对）', keys: ['Ctrl+Shift+KeyB'] }, rebindable: true },
  { id: 'edit.trimLeft', scope: 'editor', keys: [key('KeyQ')], label: '向左裁剪（删掉播放头左边）', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '向左裁剪', keys: ['KeyQ'] }, rebindable: true },
  { id: 'edit.trimRight', scope: 'editor', keys: [key('KeyW')], label: '向右裁剪（删掉播放头右边）', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '向右裁剪', keys: ['KeyW'] }, rebindable: true },
  // 04 设计问题 2: M in the editor adds a timeline marker, as in 剪映; the lighting workbench's M still stamps. On the
  // whole page, as M (which added a lighting point) did before.
  { id: 'marker.add', scope: 'editor', keys: [key('KeyM')], label: '在播放头加标记', group: '标记', kind: 'edit', repeat: 'once',
    buttons: 'items', jianying: { name: '添加标记', keys: ['KeyM'] }, rebindable: true },

  // The lighting workbench's shortcut keys (useTimelineStamp): the whole page, the user can change them. The frame
  // steps go on while held, as in 剪映 (once per press before K7), one seek per frame drawn.
  { id: 'lighting.stamp', scope: 'lighting', keys: [key('KeyM')], label: '在播放头打点', group: '灯光', kind: 'edit', repeat: 'once',
    buttons: 'leave', jianying: { name: '添加标记', keys: ['KeyM'] }, differsFromJianying: '键一样；灯光工作台的打点相当于剪映的标记', rebindable: true },
  { id: 'transport.playPause', scope: 'lighting', keys: [key('Space')], label: '播放 / 暂停', group: '播放', kind: 'transport', repeat: 'once',
    buttons: 'take', jianying: { name: '播放/暂停', keys: ['Space'] }, rebindable: true },
  { id: 'transport.prevFrame', scope: 'lighting', keys: [key('ArrowLeft')], label: '后退一帧', group: '定位', kind: 'transport', repeat: 'repeat',
    buttons: 'leave', jianying: { name: '上一帧', keys: ['ArrowLeft'] }, rebindable: true },
  { id: 'transport.nextFrame', scope: 'lighting', keys: [key('ArrowRight')], label: '前进一帧', group: '定位', kind: 'transport', repeat: 'repeat',
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

  // The timeline on both pages (ReferenceTimeline). Escape stops; with 「单按 Esc 停止」 off it clears the selection.
  { id: 'transport.stop', scope: 'timeline', keys: STOP_KEYS, label: '停止', group: '播放', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: null, rebindable: false },
  { id: 'edit.deselect', scope: 'timeline', keys: [key('Escape', { whileOff: 'plainEscapeStops' })], label: '取消选中（关掉「单按 Esc 停止」时）', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'take', jianying: null, rebindable: false },
  { id: 'transport.pause', scope: 'timeline', keys: [key('KeyK')], label: '暂停', group: '播放', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '暂停', keys: ['KeyK'] }, rebindable: true },
  { id: 'transport.play', scope: 'timeline', keys: [key('KeyL')], label: '播放', group: '播放', kind: 'transport', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '快进', keys: ['KeyL'] }, differsFromJianying: '键一样；剪映连按 L 会加速，联动台只播放', rebindable: true },
  { id: 'transport.backMany', scope: 'timeline', keys: [key('Shift+ArrowLeft')], label: '后退 5 帧', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '后退多帧（帧数待核对）', keys: ['Shift+ArrowLeft'] }, rebindable: true },
  { id: 'transport.forwardMany', scope: 'timeline', keys: [key('Shift+ArrowRight')], label: '前进 5 帧', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '前进多帧（帧数待核对）', keys: ['Shift+ArrowRight'] }, rebindable: true },
  { id: 'transport.prevEditPoint', scope: 'timeline', keys: [key('ArrowUp')], label: '上一个剪辑点', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '上一个分割点', keys: ['ArrowUp'] }, rebindable: true },
  { id: 'transport.nextEditPoint', scope: 'timeline', keys: [key('ArrowDown')], label: '下一个剪辑点', group: '定位', kind: 'transport', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '下一个分割点', keys: ['ArrowDown'] }, rebindable: true },
  { id: 'view.snap', scope: 'timeline', keys: [key('KeyN')], label: '吸附开关（吸附到片段边缘和歌曲节拍）', group: '视图', kind: 'view', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '自动吸附', keys: ['KeyN'] }, rebindable: true },
  { id: 'view.zoomIn', scope: 'timeline', keys: [key('Ctrl+Equal')], label: '放大时间线', group: '视图', kind: 'view', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '时间线放大', keys: ['Ctrl+Equal'] }, rebindable: true },
  { id: 'view.zoomOut', scope: 'timeline', keys: [key('Ctrl+Minus')], label: '缩小时间线', group: '视图', kind: 'view', repeat: 'repeat',
    area: 'timeline', buttons: 'items', jianying: { name: '时间线缩小', keys: ['Ctrl+Minus'] }, rebindable: true },
  { id: 'view.zoomFit', scope: 'timeline', keys: [key('Shift+KeyZ')], label: '缩放到合适（适合节目时长）', group: '视图', kind: 'view', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '缩放到合适', keys: ['Shift+KeyZ'] }, rebindable: true },
  { id: 'edit.copy', scope: 'timeline', keys: [key('Ctrl+KeyC')], label: '复制片段或 Cue', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '复制', keys: ['Ctrl+KeyC'] }, rebindable: false },
  { id: 'edit.paste', scope: 'timeline', keys: [key('Ctrl+KeyV')], label: '粘贴到播放头', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '粘贴', keys: ['Ctrl+KeyV'] }, rebindable: false },
  { id: 'edit.duplicate', scope: 'timeline', keys: [key('Ctrl+KeyD')], label: '在后方创建副本', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '复制片段（待核对）', keys: ['Ctrl+KeyD'] }, rebindable: true },
  { id: 'edit.split', scope: 'timeline', keys: [key('Ctrl+KeyB')], label: '在播放头分割', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '分割', keys: ['Ctrl+KeyB'] }, rebindable: true },
  { id: 'edit.delete', scope: 'timeline', keys: [key('Delete'), key('Backspace')], label: '删除', group: '剪辑', kind: 'edit', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '删除', keys: ['Delete', 'Backspace'] }, rebindable: false },
  // S split before K7. Pressed on the timeline it now says once, on this computer, that splitting moved to Ctrl+B,
  // and does nothing after that (剪映's S is its preview axis, which 联动台 has not).
  { id: 'edit.splitMoved', scope: 'timeline', keys: [key('KeyS')], label: '提示分割改成了 Ctrl+B（只提示一次）', group: '剪辑', kind: 'view', repeat: 'once',
    area: 'timeline', buttons: 'items', jianying: { name: '预览轴', keys: ['KeyS'] }, differsFromJianying: '联动台没有预览轴；S 只在第一次按时提示分割改成了 Ctrl+B', rebindable: false },

  // The lighting points (LightingTimeline): on both pages, wherever the focus is but in fields and dialogs.
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

/** The stop command's key that gets through everything (`through: 'all'`), as the table has it; the user can change it (K8). */
export const STOP_ANYWHERE: KeyChord = 'Shift+Escape';

/**
 * The table with the user's keys (`overrides`) in place of the table's, for the commands the user can change
 * (`rebindable`). A command overridden with no key has none: no key presses it. `stop`: the stop command's key that
 * gets through everything, in place of Shift+Escape, on every page. The hint that S moved (`edit.splitMoved`) gives
 * way as soon as the user gives S to a command of the editor, the lighting workbench or the timeline (K8).
 */
export function resolveKeymap(keymap: readonly KeyEntry[], overrides: KeyOverrides, stop: KeyChord = STOP_ANYWHERE): readonly KeyEntry[] {
  const resolved = keymap.map(entry => {
    if (entry.id === 'transport.stop') return { ...entry, keys: entry.keys.map(binding => binding.through === 'all' ? { ...binding, chord: stop } : binding) };
    const chords = entry.rebindable ? overrides[entry.scope]?.[entry.id] : undefined;
    return chords === undefined ? entry : { ...entry, keys: chords.map(chord => key(chord)) };
  });
  const takesS = resolved.some(entry => entry.id !== 'edit.splitMoved' && entry.rebindable && entry.keys.some(binding => binding.chord === 'KeyS'));
  return takesS ? resolved.filter(entry => entry.id !== 'edit.splitMoved') : resolved;
}

/** The keys of `id` in `scope` that work now (without the ones a switch turned off), first the one shown. */
export function commandKeys(keymap: readonly KeyEntry[], id: CommandId, scope: KeyScope, switchesOff: ReadonlySet<KeySwitch> = new Set()): readonly KeyChord[] {
  return keymap.find(entry => entry.id === id && entry.scope === scope)?.keys
    .filter(binding => bindingWorks(binding, switchesOff)).map(binding => binding.chord) ?? [];
}
