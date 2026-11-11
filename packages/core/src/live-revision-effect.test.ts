import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type LinkProject, type RundownItem } from '@tb/schema';
import { liveRevisionEffect, sameAudio, songAudioStructureKey, songStructureChanges } from './live-revision-effect';

// 0.5.9 S8a（design 02 §3.5）：拿着歌时送来的新一版，哪些当即生效、哪些等下一首。
const SHA = 'a'.repeat(64);
function song(id: string, patch: Partial<RundownItem> = {}): RundownItem {
  return parseLinkProject({ ...createEmptyLinkProject('x'), rundown: [{ id, title: id,
    referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/reference-audio/${id}.wav`, sha256: SHA, durationMs: 60_000 },
    playback: { volume: 80, startMs: 0, endMs: 0, mtcOffsetMs: 3_600_000, shortcut: '', endAction: 'stop' }, ...patch }] }).rundown[0]!;
}
function show(...items: RundownItem[]): LinkProject {
  return { ...parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal' }), rundown: items };
}
const replace = (project: LinkProject, item: RundownItem): LinkProject => ({ ...project, rundown: project.rundown.map(entry => entry.id === item.id ? item : entry) });
const playback = (item: RundownItem, patch: Partial<NonNullable<RundownItem['playback']>>): RundownItem => ({ ...item, playback: { ...item.playback!, ...patch } });

describe('songAudioStructureKey：“这首歌的音频本身”只在这里定', () => {
  const a = song('a');
  it('音量、播完后、快捷键、名字、备注、灯光（不改起始码时）都不算音频本身', () => {
    for (const changed of [playback(a, { volume: 30 }), playback(a, { endAction: 'next' }), playback(a, { shortcut: 'F1' }), { ...a, title: '改名' }, { ...a, notes: '备注' },
      { ...a, lighting: createLightingDocument() }]) {
      expect(songAudioStructureKey(changed)).toBe(songAudioStructureKey(a));
      expect(sameAudio(a, changed)).toBe(true);
    }
  });
  it('换音频文件、修剪（开始、结束）、改 MTC 起始码、音频长度变了（加空白）都算', () => {
    for (const changed of [{ ...a, referenceAudio: { ...a.referenceAudio!, sha256: 'b'.repeat(64) } }, playback(a, { startMs: 1000 }), playback(a, { endMs: 50_000 }),
      playback(a, { mtcOffsetMs: 3_700_000 }), { ...a, referenceAudio: { ...a.referenceAudio!, durationMs: 62_000 } }, { ...a, referenceAudio: undefined }]) {
      expect(songAudioStructureKey(changed)).not.toBe(songAudioStructureKey(a));
      expect(sameAudio(a, changed)).toBe(false);
    }
  });
  it('同一个对象不用算 key', () => { expect(sameAudio(a, a)).toBe(true); });
});

describe('liveRevisionEffect', () => {
  const a = song('a'), b = song('b');
  const before = show(a, b);
  const held = { itemId: 'a', started: before };
  it('这首歌没动（同一个对象）：什么都不做', () => {
    expect(liveRevisionEffect(before, replace(before, playback(b, { volume: 10 })), held)).toEqual({ volume: null, endAction: false, lighting: null, audio: false, removedHeld: false });
  });
  it('音量改了：给出新的音量；没改：null', () => {
    expect(liveRevisionEffect(before, replace(before, playback(a, { volume: 40 })), held)).toMatchObject({ volume: 40, endAction: false, audio: false });
    expect(liveRevisionEffect(before, replace(before, { ...a, title: '改名' }), held)).toMatchObject({ volume: null, endAction: false });
  });
  it('自己的播完后改了（有到没有也算）', () => {
    expect(liveRevisionEffect(before, replace(before, playback(a, { endAction: 'next' })), held).endAction).toBe(true);
    const own = replace(before, playback(a, { endAction: 'next' }));
    const { endAction, ...rest } = own.rundown[0]!.playback!; void endAction;
    expect(liveRevisionEffect(own, replace(own, { ...own.rundown[0]!, playback: { ...rest } as NonNullable<RundownItem['playback']> }), { itemId: 'a', started: own }).endAction).toBe(true);
  });
  it('灯光改了：给出新的灯光；灯光删掉：null（这首歌拿着的执行器到停止都不放）', () => {
    const lighting = createLightingDocument();
    expect(liveRevisionEffect(before, replace(before, { ...a, lighting }), held).lighting).toBe(lighting);
    const lit = replace(before, { ...a, lighting });
    expect(liveRevisionEffect(lit, replace(lit, { ...a, lighting: undefined }), { itemId: 'a', started: lit }).lighting).toBeNull();
  });
  it('音频本身和开始那一版比：改了就是 audio，什么都不接', () => {
    const trimmed = replace(before, playback(a, { startMs: 2000 }));
    expect(liveRevisionEffect(before, trimmed, held)).toMatchObject({ audio: true });
    // A later edit that leaves the trim stays different from the version the song started with.
    expect(liveRevisionEffect(trimmed, replace(trimmed, { ...trimmed.rundown[0]!, title: '再改' }), held)).toMatchObject({ audio: true });
  });
  it('删掉或停用：removedHeld 只在送来删掉它的那一版时说一次', () => {
    const removed = show(b);
    expect(liveRevisionEffect(before, removed, held)).toMatchObject({ removedHeld: true, volume: null, endAction: false, lighting: null });
    expect(liveRevisionEffect(removed, show(b, song('c')), held)).toMatchObject({ removedHeld: false });
    expect(liveRevisionEffect(before, replace(before, { ...a, enabled: false }), held)).toMatchObject({ removedHeld: true });
  });
});

describe('songStructureChanges：哪几首歌改了在台上的歌接不了的东西', () => {
  const a = song('a'), b = song('b'), c = song('c');
  const before = show(a, b, c);
  it('改音频、删掉、停用分开列；改名、改音量、调顺序、新加不算', () => {
    const after = { ...before, rundown: [playback(b, { startMs: 500 }), { ...c, enabled: false }, { ...song('d') }] };
    expect(songStructureChanges(before, after)).toEqual({ audio: ['b'], removed: ['a', 'c'] });
    expect(songStructureChanges(before, { ...before, rundown: [c, playback(a, { volume: 1 }), { ...b, title: '改名' }, song('d')] })).toEqual({ audio: [], removed: [] });
  });
  it('本来就停用的歌删掉不算', () => {
    const off = show({ ...a, enabled: false });
    expect(songStructureChanges(off, show())).toEqual({ audio: [], removed: [] });
  });
});
