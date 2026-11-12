import { createLightingDocument, lightingTrackSchema, linkCueSchema, referenceMediaClipSchema, type LightingDocument } from '@tb/schema';
import { describe, expect, it } from 'vitest';
import {
  clipboardSource, copyTarget, cuePointsToDelete, cutTarget, deleteTimelineSelection, pointAfter, pointBefore, toggleLightingClip, type TimelineClipboard, duplicateTarget, editorEditKeys, editorTransportKeys, keysBackToTimeline, timelineTransportKeys, nextEditPoint, previousEditPoint, removeLightingPoints,
  splitTarget, timelineClipboard, timelineEditKeys, timelineSelection, trimAudioToPlayhead, trimToPlayhead, TIMELINE_SELECTION_ORDER, type TimelineKeyProps
} from './timeline-commands';

/** A lighting document with one track holding the clip 「灯光片段」 and its points 「点 1」「点 2」「点 3」. */
function lightingDocument(locked = false): LightingDocument {
  const event = (id: string, at: number) => ({ id, at, kind: 'empty-cue', label: id });
  const track = lightingTrackSchema.parse({ id: '灯光轨道', name: '灯光', kind: 'ma2', color: '#336699', group: '', muted: false, solo: false, locked,
    channel: 1, portProfileId: '', controller: 0, noteNames: {},
    clips: [{ id: '灯光片段', name: '片段', start: 0, duration: 10, timeLock: 'time', muted: false, events: [event('点 1', 1), event('点 2', 2), event('点 3', 3)] }] });
  return { ...createLightingDocument(), tracks: [track] };
}

/** The timeline's key props, writing down what they were asked to do. */
function props(calls: string[], overrides: Partial<TimelineKeyProps> = {}): TimelineKeyProps {
  return {
    playheadMs: 1_000, frameRate: '25', clips: [], cues: [], selectedClipId: null, selectedCueId: null,
    onPlayingChange: () => undefined,
    onDuplicateClip: (id, at) => { calls.push(`复制 ${id} 到 ${at}`); }, onDuplicateCue: (id, at) => { calls.push(`复制 ${id} 到 ${at}`); },
    onPasteClip: (clip, at) => { calls.push(`粘贴剪切的 ${clip.id} 到 ${at}`); },
    onSplitClip: (id, at) => { calls.push(`分割 ${id} 在 ${at}`); },
    onTrim: (ref, startMs, durationMs) => { calls.push(`修剪 ${ref.id} 为 ${startMs}+${durationMs}`); },
    onDeleteClip: id => { calls.push(`删除片段 ${id}`); }, onDeleteCue: id => { calls.push(`删除触发点 ${id}`); },
    ...overrides
  };
}
/** An audio track of one segment 「音频」 from 0.5 s to 2.5 s, selected. */
const audioEditor = (calls: string[], disabled = false): NonNullable<TimelineKeyProps['audioEditor']> => ({
  selected: { id: '音频', startMs: 500, durationMs: 2_000, sourceOffsetMs: 0 }, segments: [{ startMs: 500, durationMs: 2_000 }], disabled,
  split: at => { calls.push(`分割音频 在 ${at}`); return Promise.resolve(); }, remove: () => { calls.push('删除音频'); return Promise.resolve(); },
  update: (id, patch) => { calls.push(`改音频 ${id} ${JSON.stringify(patch)}`); return Promise.resolve(); }
});

describe('时间线选中的东西归谁（04 设计 3.3 d，K6）', () => {
  it('按固定顺序看：标记、Cue 点、音频、灯光点、片段、触发点；一次只认一种', () => {
    expect(TIMELINE_SELECTION_ORDER).toEqual(['marker', 'cue-points', 'audio', 'lighting-points', 'content-clip', 'trigger']);
    const all = { workbench: false, marker: true, cuePoints: true, audio: true, lightingPoints: true, clip: '片段', trigger: '触发点' };
    expect(timelineSelection(all)).toBe('marker');
    expect(timelineSelection({ ...all, marker: false })).toBe('cue-points');
    expect(timelineSelection({ ...all, marker: false, cuePoints: false })).toBe('audio');
    expect(timelineSelection({ ...all, marker: false, cuePoints: false, audio: false })).toBe('lighting-points');
    expect(timelineSelection({ workbench: false, clip: '片段', trigger: '触发点' })).toBe('content-clip');
    expect(timelineSelection({ workbench: false, trigger: '触发点' })).toBe('trigger');
    expect(timelineSelection({ workbench: false })).toBeNull();
    // The workbench's audio is read only: its waveform is never the one Delete deletes.
    expect(timelineSelection({ workbench: true, audio: true, clip: '片段' })).toBe('content-clip');
  });

  it('一次 Delete 只删一种：音频片段和内容片段都选着时只删音频，不连片段一起删', () => {
    const calls: string[] = [];
    const document = lightingDocument();
    deleteTimelineSelection(props(calls, { audioEditor: audioEditor(calls), selectedClipId: '片段', selectedCueId: '触发点',
      lighting: { document, selectedClipId: '灯光片段', selectedEventId: '点 1', selectedEventIds: ['点 1'], onChange: () => { calls.push('删除灯光点'); }, onSelect: () => undefined } }));
    expect(calls).toEqual(['删除音频']);
    // Audio that cannot be changed now (playing) is still what Delete is about: nothing else goes instead.
    calls.length = 0;
    deleteTimelineSelection(props(calls, { audioEditor: audioEditor(calls, true), selectedClipId: '片段' }));
    expect(calls).toEqual([]);

    const changed: Array<{ document: LightingDocument; label: string }> = [], selected: Array<[string, string | null]> = [];
    deleteTimelineSelection(props(calls, { selectedClipId: '片段', lighting: { document, selectedClipId: '灯光片段', selectedEventId: '点 1', selectedEventIds: ['点 1', '点 3'],
      onChange: (next, label) => { changed.push({ document: next, label }); }, onSelect: (track, clip) => { selected.push([track, clip]); } } }));
    expect(changed.map(change => [change.label, change.document.tracks[0]!.clips[0]!.events.map(event => event.id)])).toEqual([['删除灯光点', ['点 2']]]);
    expect(selected).toEqual([['灯光轨道', '灯光片段']]);
    expect(calls).toEqual([]);

    deleteTimelineSelection(props(calls, { selectedClipId: '片段', selectedCueId: '触发点' }));
    deleteTimelineSelection(props(calls, { selectedCueId: '触发点' }));
    deleteTimelineSelection(props(calls));
    expect(calls).toEqual(['删除片段 片段', '删除触发点 触发点']);
  });

  it('Cue 点的 Delete：有选中的删选中的，没有就删焦点所在的那个，都没有就交给时间线', () => {
    expect(cuePointsToDelete(['a', 'b'], 'c')).toEqual({ kind: 'selection', ids: ['a', 'b'] });
    expect(cuePointsToDelete([], 'c')).toEqual({ kind: 'focused', id: 'c' });
    expect(cuePointsToDelete([], undefined)).toBeNull();
  });

  it('锁住的灯光轨道、没选灯光片段时不删灯光点', () => {
    expect(removeLightingPoints(lightingDocument(true), '灯光片段', ['点 1'])).toBeNull();
    expect(removeLightingPoints(lightingDocument(), null, ['点 1'])).toBeNull();
    expect(removeLightingPoints(lightingDocument(), '别的片段', ['点 1'])).toBeNull();
    expect(removeLightingPoints(lightingDocument(), '灯光片段', ['点 2'])?.document.tracks[0]!.clips[0]!.events.map(event => event.id)).toEqual(['点 1', '点 3']);
  });
});

describe('剪贴板和编辑键（04 设计 3.3 b）', () => {
  it('选着灯光片段时复制、粘贴归灯光点，时间线不复制片段也不粘贴片段；没选时归片段和触发点', () => {
    expect(timelineClipboard({ lightingClipSelected: true })).toBe('lighting');
    expect(timelineClipboard({ lightingClipSelected: false })).toBe('content');
    const calls: string[] = [];
    const lighting = { document: lightingDocument(), selectedClipId: '灯光片段', selectedEventId: null, selectedEventIds: [], onChange: () => undefined, onSelect: () => undefined };
    const withLighting = timelineEditKeys(props(calls, { selectedClipId: '片段', lighting }), { kind: 'clip', id: '片段' }, () => undefined);
    expect([withLighting['edit.copy'], withLighting['edit.paste']]).toEqual([undefined, undefined]);
    const copied: string[] = [];
    const content = timelineEditKeys(props(calls, { selectedClipId: '片段' }), { kind: 'cue', id: '触发点' }, target => { copied.push(`${target.kind} ${target.id}`); });
    content['edit.copy']?.({ target: null, global: () => undefined });
    content['edit.paste']?.({ target: null, global: () => undefined });
    expect([copied, calls]).toEqual([['clip 片段'], ['复制 触发点 到 1000']]);
    // Nothing on the clipboard, nothing selected: no paste, no copy, no split, no duplicate; Delete and stop stay.
    // The stop keys are the page's own since K7 (ReferenceTimeline), not the editing keys'.
    expect(Object.keys(timelineEditKeys(props(calls), null, () => undefined)).sort()).toEqual(['edit.delete']);
  });

  it('复制哪个、副本放在哪：片段放在它后面，触发点放在它和它的长度后面；找不到就不放', () => {
    const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
    const clip = referenceMediaClipSchema.parse({ id: '片段', assetId: '素材', startTimecode: at(1), durationMs: 2_000, label: '片段' });
    const cue = linkCueSchema.parse({ id: '触发点', name: '触发点', timecode: at(2), durationMs: 500 });
    expect(copyTarget({ clip: '片段', trigger: '触发点' })).toEqual({ kind: 'clip', id: '片段' });
    expect(copyTarget({ clip: null, trigger: '触发点' })).toEqual({ kind: 'cue', id: '触发点' });
    expect(copyTarget({ clip: null, trigger: null })).toBeNull();
    expect(duplicateTarget({ clip: null, trigger: '触发点' }, [], [cue], '25')).toEqual({ kind: 'cue', id: '触发点', at: 2_500 });
    expect(duplicateTarget({ clip: '片段', trigger: null }, [], [], '25')).toEqual({ kind: 'clip', id: '片段', at: null });
    expect(duplicateTarget({ clip: '片段', trigger: null }, [clip], [], '25')).toEqual({ kind: 'clip', id: '片段', at: 3_000 });
    expect(duplicateTarget({ clip: null, trigger: null }, [clip], [cue], '25')).toBeNull();
  });

  it('Ctrl+B 分割（K7 前是 S）：编辑器里选着能改的音频片段就分割音频，否则分割选中的片段；灯光工作台的音频不分割', () => {
    expect(splitTarget({ workbench: false, audio: true, audioDisabled: false, clip: '片段' })).toBe('audio');
    expect(splitTarget({ workbench: false, audio: true, audioDisabled: true, clip: '片段' })).toBe('content-clip');
    expect(splitTarget({ workbench: true, audio: true, audioDisabled: false, clip: null })).toBeNull();
    expect(splitTarget({ workbench: false, audio: false, audioDisabled: false, clip: null })).toBeNull();
    const calls: string[] = [];
    timelineEditKeys(props(calls, { audioEditor: audioEditor(calls), selectedClipId: '片段' }), null, () => undefined)['edit.split']?.({ target: null, global: () => undefined });
    expect(calls).toEqual(['分割音频 在 1000']);
  });
});

describe('剪映的键（K7）', () => {
  const press = { target: null, global: () => undefined };
  const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
  const clip = (id: string, layerId: string, start: number) => referenceMediaClipSchema.parse({ id, assetId: '素材', startTimecode: at(start), durationMs: 2_000, label: id, layerId });

  it('Q、W 把选中的音频片段的开头、结尾修剪到播放头；没选音频就修剪选中的片段；播放头不在里面、轨道锁着时不动', () => {
    const calls: string[] = [];
    editorEditKeys(props(calls, { audioEditor: audioEditor(calls), selectedClipId: '片段' }))['edit.trimLeft']?.(press);
    editorEditKeys(props(calls, { audioEditor: audioEditor(calls) }))['edit.trimRight']?.(press);
    expect(calls).toEqual(['改音频 音频 {"startMs":1000,"sourceOffsetMs":500,"durationMs":1500}', '改音频 音频 {"durationMs":500}']);
    calls.length = 0;
    const clips = [clip('片段', '轨道 1', 0), clip('锁着的', '轨道 2', 0), clip('后面的', '轨道 1', 5)];
    const layers = [{ id: '轨道 1', locked: false }, { id: '轨道 2', locked: true }];
    editorEditKeys(props(calls, { clips, layers, selectedClipId: '片段' }))['edit.trimLeft']?.(press);
    editorEditKeys(props(calls, { clips, layers, selectedClipId: '锁着的' }))['edit.trimRight']?.(press);
    editorEditKeys(props(calls, { clips, layers, selectedClipId: '后面的' }))['edit.trimRight']?.(press);
    expect(calls).toEqual(['修剪 片段 为 1000+1000']);
  });

  it('Ctrl+Shift+B 在播放头分割所有片段和音频，锁着的轨道、不经过播放头的片段不分', () => {
    const calls: string[] = [];
    const clips = [clip('片段', '轨道 1', 0), clip('锁着的', '轨道 2', 0), clip('后面的', '轨道 1', 5)];
    editorEditKeys(props(calls, { clips, layers: [{ id: '轨道 1', locked: false }, { id: '轨道 2', locked: true }], audioEditor: audioEditor(calls) }))['edit.splitAll']?.(press);
    expect(calls).toEqual(['分割 片段 在 1000', '分割音频 在 1000']);
  });

  it('Ctrl+Shift+B 分的几个片段算同一次：给它们同一个撤销组，下一次按键换一个；单独分割不带组', () => {
    const groups: Array<string | undefined> = [];
    const clips = [clip('上面的', '轨道 1', 0), clip('下面的', '轨道 2', 0)];
    const keyProps = props([], { clips, selectedClipId: '上面的', onSplitClip: (_id, _at, group) => { groups.push(group); } });
    editorEditKeys(keyProps)['edit.splitAll']?.(press);
    editorEditKeys(keyProps)['edit.splitAll']?.(press);
    expect(groups).toHaveLength(4);
    expect(groups[0]).toMatch(/^split-all:/);
    expect(groups[1]).toBe(groups[0]);
    expect(groups[3]).toBe(groups[2]);
    expect(groups[2]).not.toBe(groups[0]);
    timelineEditKeys(keyProps, null, () => undefined)['edit.split']?.(press);
    expect(groups).toHaveLength(5);
    expect(groups[4]).toBeUndefined();
  });

  it('K 暂停、L 播放；Shift+←/→ 走 5 帧，↑↓ 到上一个、下一个剪辑点，先暂停，不出开头和结尾', () => {
    const log: string[] = [];
    let playhead = 1_000;
    const seek = { from: () => playhead, to: (ms: number) => { playhead = ms; log.push(`到 ${ms}`); } };
    const keys = (playing: boolean) => timelineTransportKeys({ frameRate: '25', durationMs: 3_000, editPoints: [500, 2_000], markers: [], beats: [], playing },
      { playPause: () => log.push('播放键'), onPlayingChange: next => log.push(next ? '播放' : '暂停'), seek });
    keys(true)['transport.pause']?.(press); keys(false)['transport.pause']?.(press);
    keys(false)['transport.play']?.(press); keys(true)['transport.play']?.(press);
    expect(log).toEqual(['暂停', '播放键']);
    log.length = 0;
    keys(false)['transport.forwardMany']?.(press); keys(false)['transport.backMany']?.(press); keys(false)['transport.backMany']?.(press);
    keys(false)['transport.nextEditPoint']?.(press); keys(false)['transport.nextEditPoint']?.(press); keys(false)['transport.prevEditPoint']?.(press);
    expect(log).toEqual(['暂停', '到 1200', '暂停', '到 1000', '暂停', '到 800', '暂停', '到 2000', '暂停', '到 3000', '暂停', '到 2000']);
    playhead = 50;
    keys(false)['transport.backMany']?.(press);
    expect(playhead).toBe(0);
  });

  it('按住 ← 时每一下从上一下要去的地方接着走，没画出来的也算（每帧只定位一次，04 设计 4.9）', () => {
    const drawn = 1_000, targets: number[] = [];
    let pending: number | null = null;
    const seek = { from: () => pending ?? drawn, to: (ms: number) => { pending = ms; targets.push(ms); } };
    const keys = editorTransportKeys({ frameRate: '25', onPlayingChange: () => undefined, durationMs: 3_000 }, () => undefined, seek);
    for (let index = 0; index < 3; index += 1) keys['transport.prevFrame']?.(press);
    expect(targets).toEqual([960, 920, 880]);
  });
});

describe('剪辑点和修剪到播放头（从 TimelineToolbar 和右键菜单搬来）', () => {
  it('上一个、下一个剪辑点：离播放头不到半帧的不算，没有就是开头、结尾', () => {
    const points = [0, 1_000, 2_000, 3_000];
    expect(previousEditPoint(points, 2_000, '25')).toBe(1_000);
    expect(previousEditPoint(points, 2_010, '25')).toBe(1_000);
    expect(previousEditPoint(points, 2_030, '25')).toBe(2_000);
    expect(previousEditPoint([500], 400, '25')).toBe(0);
    expect(nextEditPoint(points, 2_000, '25', 9_000)).toBe(3_000);
    expect(nextEditPoint(points, 1_990, '25', 9_000)).toBe(3_000);
    expect(nextEditPoint(points, 1_970, '25', 9_000)).toBe(2_000);
    expect(nextEditPoint(points, 3_500, '25', 9_000)).toBe(9_000);
  });

  it('把开头或结尾修剪到播放头；音频片段按整毫秒，开头修剪时音频的起点跟着挪', () => {
    expect(trimToPlayhead({ startMs: 1_000, endMs: 5_000 }, 2_000, 'start')).toEqual({ startMs: 2_000, durationMs: 3_000 });
    expect(trimToPlayhead({ startMs: 1_000, endMs: 5_000 }, 2_000, 'end')).toEqual({ startMs: 1_000, durationMs: 1_000 });
    const segment = { startMs: 1_000, durationMs: 4_000, sourceOffsetMs: 500 };
    expect(trimAudioToPlayhead(segment, 2_000.4, 'start')).toEqual({ startMs: 2_000, sourceOffsetMs: 1_500, durationMs: 3_000 });
    expect(trimAudioToPlayhead(segment, 2_000.6, 'end')).toEqual({ durationMs: 1_001 });
  });
});

type Node = { tag: string; attributes?: Record<string, string>; parent?: Node };
type Fake = { node: Node; closest(selectors: string): Fake | null; getAttribute(name: string): string | null };

/** One selector of the kinds the key helpers use: `tag`, `.class`, `[name]`, `[name="value"]`, and a tag with either. */
function matches(candidate: Node, selector: string): boolean {
  const parts = /^([a-z]*)((?:\.[a-z-]+)*)((?:\[[a-z-]+(?:="[^"]*")?\])*)$/.exec(selector.trim());
  if (!parts) throw new Error(`测试里的元素不认识这个选择器：${selector}`);
  const [, tag = '', classes = '', attributes = ''] = parts;
  if (tag && candidate.tag !== tag) return false;
  if (classes.split('.').filter(Boolean).some(name => !candidate.attributes?.class?.split(' ').includes(name))) return false;
  return [...attributes.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)].every(([, name = '', value]) => {
    const actual = candidate.attributes?.[name];
    return actual !== undefined && (value === undefined || actual === value);
  });
}
/** A focused or clicked element, with `closest` over its parent chain. */
function element(node: Node): Fake {
  return {
    node,
    closest: (selectors: string) => {
      for (let current: Node | undefined = node; current; current = current.parent) {
        const candidate = current;
        if (selectors.split(',').some(selector => matches(candidate, selector))) return element(candidate);
      }
      return null;
    },
    getAttribute: (name: string) => node.attributes?.[name] ?? null
  };
}
const within = (node: Node, ancestor: Node): boolean => node === ancestor || (node.parent !== undefined && within(node.parent, ancestor));

const timeline: Node = { tag: 'section', attributes: { class: 'reference-timeline' } };
const toolbar: Node = { tag: 'div', attributes: { class: 'timeline-toolbar' }, parent: timeline };
const playButton: Node = { tag: 'button', attributes: { class: 'timeline-play-button' }, parent: toolbar };

// From timeline-keys.test.ts, unchanged.
it('鼠标点完时间线工具栏上的按钮，键交还给时间线，M、←、→ 照常可用；键盘按的、正要打开菜单或面板的按钮留住焦点（0.5.9）', () => {
  const bar = { contains: (button: Fake) => within(button.node, toolbar) };
  const modes: Node = { tag: 'div', attributes: { role: 'group' }, parent: toolbar };
  const select: Node = { tag: 'button', attributes: { 'aria-pressed': 'true' }, parent: modes };
  const record: Node = { tag: 'button', attributes: { class: 'timeline-record-button' }, parent: toolbar };
  for (const node of [playButton, { tag: 'svg', parent: playButton }, select, record]) expect(keysBackToTimeline({ detail: 1, target: element(node) }, bar)).toBe(true);
  // Pressed from the keyboard: the focus stays on the button.
  expect(keysBackToTimeline({ detail: 0, target: element(playButton) }, bar)).toBe(false);
  // A menu or panel button: opening it leaves the keys to the menu or panel, closing it gives them back.
  const menu: Node = { tag: 'button', attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, parent: toolbar };
  const panel: Node = { tag: 'button', attributes: { 'aria-haspopup': 'dialog', 'aria-expanded': 'true' }, parent: toolbar };
  expect(keysBackToTimeline({ detail: 1, target: element(menu) }, bar)).toBe(false);
  expect(keysBackToTimeline({ detail: 1, target: element(panel) }, bar)).toBe(true);
  // Clicks in a menu or panel the toolbar opened (mounted on the page body), and on what is not a button.
  const item: Node = { tag: 'button', attributes: { role: 'menuitem' }, parent: { tag: 'body' } };
  for (const target of [element(item), element({ tag: 'select', parent: toolbar }), null]) expect(keysBackToTimeline({ detail: 1, target }, bar)).toBe(false);
});

describe('K10 的键：剪切、停用灯光片段、手动踩点、上一个 / 下一个标记和节拍', () => {
  const press = { target: null, global: () => undefined };
  const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
  const clip = (id: string, layerId: string) => referenceMediaClipSchema.parse({ id, assetId: '素材', startTimecode: at(0), durationMs: 2_000, label: id, layerId });

  it('Ctrl+X 剪切选中的画面片段：放进剪贴板（连同剪切时的样子）再删掉，删除是一步；粘贴放回剪切的那一份；锁着的轨道不剪；灯光工作台、触发点、选着灯光片段时不归它', () => {
    const calls: string[] = [];
    const clips = [clip('片段', '轨道 1'), clip('锁着的', '轨道 2')];
    const layers = [{ id: '轨道 1', locked: false }, { id: '轨道 2', locked: true }];
    let clipboard: TimelineClipboard | null = null;
    timelineEditKeys(props(calls, { clips, layers, selectedClipId: '片段' }), null, target => { clipboard = target; })['edit.cut']?.(press);
    expect(calls).toEqual(['删除片段 片段']);
    expect(clipboard).toEqual({ kind: 'clip', id: '片段', cut: clips[0] });
    // The clip is gone from the song: paste puts the cut one back at the playhead.
    calls.length = 0;
    timelineEditKeys(props(calls, { clips: [clips[1]!] }), clipboard, () => undefined)['edit.paste']?.(press);
    expect(calls).toEqual(['粘贴剪切的 片段 到 1000']);
    // Undone (the clip is back): paste copies it as copy does.
    calls.length = 0;
    timelineEditKeys(props(calls, { clips }), clipboard, () => undefined)['edit.paste']?.(press);
    expect(calls).toEqual(['复制 片段 到 1000']);
    expect(clipboardSource(clipboard, [], [])).toBe(clips[0]);
    // A locked track: the key is taken, nothing happens.
    calls.length = 0;
    const locked = timelineEditKeys(props(calls, { clips, layers, selectedClipId: '锁着的' }), null, () => { calls.push('放进剪贴板'); });
    locked['edit.cut']?.(press);
    expect([Boolean(locked['edit.cut']), calls]).toEqual([true, []]);
    expect(cutTarget({ clips, layers, cues: [], selectedClipId: '片段', lightingWorkspace: true })).toBeNull();
    const lighting = { document: lightingDocument(), selectedClipId: '灯光片段', selectedEventId: null, selectedEventIds: [], onChange: () => undefined, onSelect: () => undefined };
    expect(timelineEditKeys(props(calls, { clips, selectedClipId: '片段', lighting }), null, () => undefined)['edit.cut']).toBeUndefined();
    expect(timelineEditKeys(props(calls, { selectedCueId: '触发点' }), null, () => undefined)['edit.cut']).toBeUndefined();
  });

  it('V 停用、再按启用选中的灯光片段（一步撤销）；锁着的轨道不动；没选灯光片段时不归它（画面片段没有停用）', () => {
    const changes: string[] = [];
    let document = lightingDocument();
    const lighting = () => ({ document, selectedClipId: '灯光片段', selectedEventId: null, selectedEventIds: [], onChange: (next: LightingDocument, label: string) => { document = next; changes.push(label); }, onSelect: () => undefined });
    timelineEditKeys(props([], { lighting: lighting() }), null, () => undefined)['edit.toggleEnabled']?.(press);
    expect([changes, document.tracks[0]!.clips[0]!.muted]).toEqual([['停用灯光片段'], true]);
    timelineEditKeys(props([], { lighting: lighting() }), null, () => undefined)['edit.toggleEnabled']?.(press);
    expect([changes, document.tracks[0]!.clips[0]!.muted]).toEqual([['停用灯光片段', '启用灯光片段'], false]);
    expect(toggleLightingClip({ ...lighting(), document: lightingDocument(true) })).toBe('locked');
    expect(timelineEditKeys(props([], { selectedClipId: '片段' }), null, () => undefined)['edit.toggleEnabled']).toBeUndefined();
  });

  it('Ctrl+J 在播放头踩一个拍点，交给这首歌的节拍（useMusicBeatSegments）；没有歌时不归它', () => {
    const taps: number[] = [];
    timelineEditKeys(props([]), null, () => undefined, ms => { taps.push(ms); })['beat.add']?.(press);
    expect(taps).toEqual([1_000]);
    expect(timelineEditKeys(props([]), null, () => undefined)['beat.add']).toBeUndefined();
  });

  it('Shift+M / Alt+Shift+M 到下一个、上一个标记，节拍键到下一个、上一个节拍；先暂停，离播放头不到半帧的不算，前后没有就不动', () => {
    const log: string[] = [];
    let playhead = 1_000;
    const seek = { from: () => playhead, to: (ms: number) => { playhead = ms; log.push(`到 ${ms}`); } };
    const keys = timelineTransportKeys({ frameRate: '25', durationMs: 9_000, editPoints: [], markers: [500, 1_010, 4_000], beats: [0, 980, 1_500], playing: false },
      { playPause: () => undefined, onPlayingChange: next => log.push(next ? '播放' : '暂停'), seek });
    keys['marker.next']?.(press); keys['marker.next']?.(press); keys['marker.previous']?.(press); keys['marker.previous']?.(press); keys['marker.previous']?.(press);
    expect(log).toEqual(['暂停', '到 4000', '暂停', '到 1010', '暂停', '到 500']);
    log.length = 0;
    playhead = 1_000;
    keys['transport.nextBeat']?.(press); keys['transport.nextBeat']?.(press); keys['transport.prevBeat']?.(press);
    expect(log).toEqual(['暂停', '到 1500', '暂停', '到 980']);
    expect([pointAfter([500], 500, '25'), pointBefore([500], 510, '25'), pointBefore([500], 530, '25')]).toEqual([undefined, undefined, 500]);
  });
});
