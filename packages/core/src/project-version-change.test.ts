import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type RundownItem } from '@tb/schema';
import { applyProjectItemsChange, projectItemsChange } from './project-version-change';

// 0.5.9 S9（design 02 §3.3、§3.7）：增量拼在节目手里的那一版上，结果和整份发送逐字段相等；检查和整份走同一套。
const SHA = 'a'.repeat(64);
const tc = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const video = { id: 'clip-video', name: '开场视频', kind: 'video' as const, folderId: null, relativePath: 'assets/reference-media/open.mp4',
  sha256: SHA, byteLength: 10, durationMs: 4000, width: 1080, height: 1920 };
function song(id: string, title = id): RundownItem {
  return parseLinkProject({ ...createEmptyLinkProject('x'), rundown: [{ id, title,
    referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/reference-audio/${id}.wav`, sha256: SHA, durationMs: 60000 },
    cues: [{ id: `cue-${id}`, name: '开场', timecode: tc(1) }] }] }).rundown[0]!;
}
function show(count: number): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', mediaAssets: [video],
    rundown: Array.from({ length: count }, (_, index) => song(`s${index}`)) });
}
/** What the whole document would have given: the window's project written out and read back, as the program reads it. */
const whole = (project: LinkProject): LinkProject => parseLinkProject(JSON.parse(JSON.stringify(project)));
/** The increment from `before` to `after`, through the wire (JSON), put on `base`. */
function carried(base: LinkProject, before: LinkProject, after: LinkProject): LinkProject {
  const change = projectItemsChange(before, after);
  if (!change) throw new Error('这一步应该送增量');
  return applyProjectItemsChange(base, JSON.parse(JSON.stringify(change)) as typeof change);
}

/** A small seeded generator, so a failing sequence can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}

/** One edit as the document store makes it: only what it touched is a new object, everything else keeps its reference. */
function edit(project: LinkProject, next: () => number, made: { count: number }): LinkProject {
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const kind = pick(['title', 'cue', 'remove', 'add', 'move', 'shell', 'clip', 'volume'] as const);
  const rundown = project.rundown;
  const at = Math.floor(next() * rundown.length);
  switch (kind) {
    case 'title': return rundown.length ? { ...project, rundown: rundown.map((item, index) => index === at ? { ...item, title: `${item.title}+` } : item) } : project;
    case 'cue': return rundown.length ? { ...project, rundown: rundown.map((item, index) => index === at
      ? { ...item, cues: [...item.cues, { id: `cue-new-${made.count++}`, name: '新 Cue', timecode: tc(2), enabled: true, notes: '', actions: [] }] } : item) } : project;
    case 'remove': return rundown.length ? { ...project, rundown: rundown.filter((_, index) => index !== at) } : project;
    case 'add': {
      const added = song(`new-${made.count++}`);
      return { ...project, rundown: [...rundown.slice(0, at), added, ...rundown.slice(at)] };
    }
    case 'move': {
      if (rundown.length < 2) return project;
      const moved = [...rundown], [item] = moved.splice(at, 1);
      moved.splice(Math.floor(next() * moved.length), 0, item!);
      return { ...project, rundown: moved };
    }
    case 'shell': return { ...project, name: `${project.name}+`, updatedAt: new Date(Date.UTC(2026, 10, 11, 0, 0, made.count++)).toISOString() };
    case 'clip': return rundown.length ? { ...project, rundown: rundown.map((item, index) => index === at ? { ...item, referenceMediaClips: [...item.referenceMediaClips,
      { id: `clip-${made.count++}`, assetId: video.id, startTimecode: tc(0), durationMs: 1000, label: '视频', canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } }] } : item) } : project;
    case 'volume': return rundown.length ? { ...project, rundown: rundown.map((item, index) => index === at
      ? { ...item, playback: { volume: Math.floor(next() * 100), startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: '' } } : item) } : project;
  }
}

describe('增量和整份发送逐字段相等', () => {
  it('随机编辑序列（改条目、删条目、加条目、调顺序、改外壳，连着几次再送）：每一版拼出来的和整份读出来的一样', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const next = random(seed), made = { count: 0 };
      let window = show(6), program = whole(window);
      for (let version = 0; version < 25; version += 1) {
        // Some versions are several edits at once (edits while one was on its way).
        let after = window;
        const edits = 1 + Math.floor(next() * 3);
        for (let step = 0; step < edits; step += 1) after = edit(after, next, made);
        program = carried(program, window, after);
        expect(program, `seed ${seed} version ${version}`).toEqual(whole(after));
        expect(JSON.stringify(program)).toBe(JSON.stringify(whole(after)));
        window = after;
      }
    }
  });

  it('只带改过的歌：没改的歌、顺序和外壳不送', () => {
    const before = show(4), after = { ...before, rundown: before.rundown.map((item, index) => index === 2 ? { ...item, title: '改了' } : item) };
    const change = projectItemsChange(before, after);
    expect(change).toEqual({ kind: 'items', items: [JSON.stringify(after.rundown[2])], removed: [] });
    expect(projectItemsChange(before, { ...before, name: '新名字' })).toEqual({ kind: 'items', items: [], removed: [],
      shell: JSON.stringify({ ...before, name: '新名字', rundown: undefined }) });
    const moved = { ...before, rundown: [before.rundown[1]!, before.rundown[0]!, ...before.rundown.slice(2)] };
    expect(projectItemsChange(before, moved)).toEqual({ kind: 'items', items: [], removed: [], order: moved.rundown.map(item => item.id) });
    const removed = { ...before, rundown: before.rundown.slice(1) };
    expect(projectItemsChange(before, removed)).toEqual({ kind: 'items', items: [], removed: ['s0'] });
  });

  it('改的歌太多就整份送（null）', () => {
    const before = show(600), after = { ...before, rundown: before.rundown.map(item => ({ ...item, title: `${item.title}+` })) };
    expect(projectItemsChange(before, after)).toBeNull();
    expect(projectItemsChange(before, { ...before, rundown: [] })).toBeNull();
  });
});

describe('增量拼不上节目手里的那一版就拒绝，节目手里的不变', () => {
  const base = show(3);
  it('歌重复、删掉的歌节目没有、顺序和歌对不上', () => {
    const item = JSON.stringify(base.rundown[0]);
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [item, item], removed: [] })).toThrow('同一首歌出现了两次');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [], removed: ['没有这首'] })).toThrow('这一版要删掉的歌节目这边没有');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [item], removed: ['s0'] })).toThrow('这一版要删掉的歌节目这边没有');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [], removed: [], order: ['s0', 's1'] })).toThrow('歌曲顺序');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [], removed: [], order: ['s0', 's1', 's1'] })).toThrow('歌曲顺序');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [], removed: [], order: ['s0', 's1', 'x'] })).toThrow('歌曲顺序');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [], removed: ['s2'], order: ['s0', 's1', 's2'] })).toThrow('歌曲顺序');
  });

  it('改动的一首歌自己不合规：按歌曲的格式拦住', () => {
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [JSON.stringify({ ...base.rundown[0], title: '' })], removed: [] })).toThrow();
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [JSON.stringify({ ...base.rundown[0],
      referenceAudio: { ...base.rundown[0]!.referenceAudio, relativePath: '../外面.wav' } })], removed: [] })).toThrow('工程内相对路径');
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [], removed: [], shell: JSON.stringify({ ...base, name: '', rundown: undefined }) })).toThrow();
  });

  it('跨歌的关系坏了（和别的歌重了 ID 或快捷键、引用了外壳里删掉的素材）：整个工程的关系检查拦住', () => {
    const clash = { ...base.rundown[0]!, cues: [{ ...base.rundown[0]!.cues[0]!, id: 'cue-s1' }] };
    expect(() => applyProjectItemsChange(base, { kind: 'items', items: [JSON.stringify(clash)], removed: [] })).toThrow('ID 重复：cue-s1');
    const shortcut = (item: RundownItem): RundownItem => ({ ...item, playback: { volume: 100, startMs: 0, endMs: 0, mtcOffsetMs: 0, shortcut: 'F1' } });
    const keyed = applyProjectItemsChange(base, { kind: 'items', items: [JSON.stringify(shortcut(base.rundown[0]!))], removed: [] });
    expect(() => applyProjectItemsChange(keyed, { kind: 'items', items: [JSON.stringify(shortcut(base.rundown[2]!))], removed: [] })).toThrow('歌曲快捷键重复');
    const clip = { ...base.rundown[1]!, referenceMediaClips: [{ id: 'clip', assetId: video.id, startTimecode: tc(0), durationMs: 1000, label: '视频',
      canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } }] };
    const clipped = applyProjectItemsChange(base, { kind: 'items', items: [JSON.stringify(clip)], removed: [] });
    expect(() => applyProjectItemsChange(clipped, { kind: 'items', items: [], removed: [], shell: JSON.stringify({ ...clipped, mediaAssets: [], rundown: undefined }) }))
      .toThrow(video.id);
  });
});
