import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { MidiProgramSession } from './midi-program';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SceneOutputTimeline } from './scene-output-timeline';
import { TimelineStateIndex } from './timeline-state';

/**
 * Output rules the operator set on 2026-11-10 (design 01 §7.1), one describe block per rule, in the operator's
 * words. Like lighting-workflow-rules.test.ts: a change that breaks a rule fails here even when the tests written
 * for that change still pass. Rules are numbered as in the design; later steps append theirs below.
 */

// ---- Action MIDI (rules 6 and 7) ----

function midiShow(cues: { frame: number; actions: LinkAction[] }[], options: { sendCostMs?: number } = {}) {
  const project = parseLinkProject({ ...createEmptyLinkProject('输出规则'), playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲',
    cues: cues.map((cue, index) => ({ id: `cue-${index}`, name: `Cue ${index}`, timecode: frameNumberToTimecode(cue.frame, '30'), actions: cue.actions })) }] });
  let now = 1000;
  const sent: number[][] = [], missed: string[] = [], late: string[] = [], errors: Error[] = [];
  // A device that takes a while to accept each message, as a slow interface does.
  const send = vi.fn((_port: string, bytes: readonly number[]) => new Promise<void>(resolve => setImmediate(() => {
    now += options.sendCostMs ?? 0; sent.push([...bytes]); resolve();
  })));
  const session = new MidiProgramSession(project, 'song', { prepare: () => Promise.resolve(), send, close: () => Promise.resolve(), now: () => now,
    sent: () => undefined, missed: message => missed.push(message), late: message => late.push(message), failed: error => errors.push(error) }, 'live');
  return { session, sent, missed, late, errors, at: (value: number) => { now = value; }, now: () => now };
}
const action = {
  pc: (id: string, program: number): LinkAction => ({ id, label: id, kind: 'midi.programChange', portProfileId: 'out', channel: 1, program }),
  cc: (id: string, value: number): LinkAction => ({ id, label: id, kind: 'midi.controlChange', portProfileId: 'out', channel: 1, controller: 7, value }),
  on: (id: string, note: number): LinkAction => ({ id, label: id, kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note, velocity: 100 }),
  off: (id: string, note: number): LinkAction => ({ id, label: id, kind: 'midi.noteOff', portProfileId: 'out', channel: 1, note, velocity: 0 }),
  msc: (id: string, command: 'go' | 'stop'): LinkAction => ({ id, label: id, kind: 'midi.showControl', portProfileId: 'out', deviceId: 1, commandFormat: 1, command, cueNumber: '1' })
};

describe('规则 6：动作 MIDI 晚了，PC、CC 照发；Note On、MSC Go 晚 100 ms 跳过这一条；Note Off、MSC Stop 总是发', () => {
  it('晚 2 秒：PC、CC、Note Off、MSC Stop 发出，Note On、MSC Go 跳过并记为错过，通道照常', async () => {
    const f = midiShow([{ frame: 0, actions: [action.pc('PC', 5), action.cc('CC', 1), action.on('按键', 60), action.msc('Go', 'go'), action.off('松开', 61), action.msc('Stop', 'stop')] },
      { frame: 90, actions: [action.on('下一条', 62)] }]);
    await f.session.prepare(0); f.at(3000); f.session.clock(0, 1000); await f.session.settled();
    expect(f.sent).toEqual([[0xc0, 5], [0xb0, 7, 1], [0x80, 61, 0], [0xf0, 0x7f, 1, 0x02, 0x01, 0x02, 0x31, 0xf7]]);
    expect(f.missed).toEqual(['播放位置更新中断，错过了 2 个 MIDI 动作，没有补发']);
    expect(f.late).toHaveLength(1); expect(f.late[0]).toContain('晚了 2000 ms 才发出：PC、CC');
    f.at(4000); f.session.clock(3000, 4000); await f.session.settled();
    expect(f.sent.at(-1)).toEqual([0x90, 62, 100]); expect(f.errors).toEqual([]); expect(f.session.error).toBeNull();
    await f.session.close();
  });

  it('晚不到 100 ms 的 Note On 照发，100 ms 整就跳过', async () => {
    const f = midiShow([{ frame: 0, actions: [action.on('准时', 60)] }, { frame: 3, actions: [action.on('晚了', 61)] }]);
    await f.session.prepare(0); f.at(1099); f.session.clock(0, 1000); await f.session.settled();
    f.at(1200); f.session.clock(100, 1100); await f.session.settled();
    expect(f.sent).toEqual([[0x90, 60, 100]]); expect(f.missed).toHaveLength(1); expect(f.errors).toEqual([]);
    await f.session.close();
  });
});

describe('规则 7：同一时刻 100 条动作不会停整路', () => {
  it('一帧 100 条（PC 和 Note On 各一半），接口每条要 3 ms：PC 全发，晚了的 Note On 只跳过它自己，后面的动作照发', async () => {
    const actions = Array.from({ length: 100 }, (_, index) => index % 2 ? action.on(`N${index}`, index) : action.pc(`P${index}`, index));
    const f = midiShow([{ frame: 0, actions }, { frame: 30, actions: [action.pc('之后', 1)] }], { sendCostMs: 3 });
    await f.session.prepare(0); f.session.clock(0, 1000); await f.session.settled();
    expect(f.errors).toEqual([]); expect(f.session.error).toBeNull();
    expect(f.sent.filter(bytes => bytes[0] === 0xc0)).toHaveLength(50);
    const notes = f.sent.filter(bytes => bytes[0] === 0x90).length;
    expect(notes).toBeGreaterThan(0); expect(notes).toBeLessThan(50);
    expect(f.missed).toEqual([expect.stringContaining(`等 ${50 - notes} 个`)]);
    f.session.clock(1000, f.now()); await f.session.settled();
    expect(f.sent.at(-1)).toEqual([0xc0, 1]); expect(f.errors).toEqual([]);
    await f.session.close();
  });

  it('全是 PC 时 100 条一条不少', async () => {
    const f = midiShow([{ frame: 0, actions: Array.from({ length: 100 }, (_, index) => action.pc(`P${index}`, index)) }], { sendCostMs: 3 });
    await f.session.prepare(0); f.session.clock(0, 1000); await f.session.settled();
    expect(f.sent).toHaveLength(100); expect(f.missed).toEqual([]); expect(f.errors).toEqual([]);
    await f.session.close();
  });
});

// ---- Picture (rule 1; the `:duration-end` part comes with R4) ----

/** Three tracks: a camera over a video (covering 10–15 s), a shown caption, a clip above a camera, a sound under a camera, a camera with no length. */
function pictureShow() {
  const at = (seconds: number) => frameNumberToTimecode(seconds * 30, '30');
  const asset = (id: string, kind: 'video' | 'image' | 'audio') => ({ id, name: id, kind, folderId: null, relativePath: `assets/${id}`, sha256: { video: 'a', logo: 'b', clap: 'c' }[id]!.repeat(64),
    byteLength: 1, ...(kind === 'image' ? {} : { durationMs: 600_000 }), ...(kind === 'audio' ? {} : { width: 1080, height: 1920 }) });
  const scene = (id: string, layerId: string, start: number, seconds?: number) => ({ id, name: id, layerId, timecode: at(start), ...(seconds === undefined ? {} : { durationMs: seconds * 1000 }),
    actions: [{ id: `${id}-scene`, label: id, kind: 'obs.setProgramScene' as const, sceneName: `机位 ${id}` }] });
  const clip = (id: string, assetId: string, layerId: string, start: number, seconds: number) =>
    ({ id, assetId, label: id, layerId, startTimecode: at(start), durationMs: seconds * 1000, sourceOffsetMs: 0 });
  return parseLinkProject({ ...createEmptyLinkProject('画面规则'), obsOutputMode: 'scenes', mediaAssets: [asset('video', 'video'), asset('logo', 'image'), asset('clap', 'audio')],
    rundown: [{ id: 'song', title: '歌',
      visualLayers: ['top', 'middle', 'bottom'].map(id => ({ id, name: id, visible: true, locked: false })),
      referenceMediaClips: [clip('dance', 'video', 'bottom', 6, 24), clip('logo-clip', 'logo', 'top', 20, 4), clip('clap-clip', 'clap', 'bottom', 32, 4)],
      cues: [scene('wide', 'middle', 10, 5), scene('close', 'middle', 18, 8), scene('open', 'middle', 30),
        { id: 'caption', name: '字幕', layerId: 'top', timecode: at(12), durationMs: 3000,
          actions: [{ id: 'caption-show', label: '字幕', kind: 'obs.setSceneItemEnabled' as const, sceneName: '机位 wide', sourceName: '字幕', enabled: true }] }],
      referenceAudio: { assetId: 'song-audio', relativePath: 'assets/song.wav', sha256: 'e'.repeat(64), durationMs: 40_000 } }] });
}

describe('规则 1：某一帧该显示什么只有一处', () => {
  it('编辑器舞台、离线预览、正式播出逐帧都照 pictureAt：机位盖住的视频哪儿都不算在播，音效不被盖', () => {
    const project = pictureShow(), item = project.rundown[0]!;
    const timeline = new SceneOutputTimeline(project, 'song'), stage = new TimelineStateIndex(project, item);
    let covered = 0;
    for (let frame = 0; frame < 40 * 30; frame++) {
      const picture = timeline.pictureAt(frame), ms = frame / 30 * 1000;
      const visible = picture.clips.map(clip => clip.clipId), heard = picture.sounds.map(clip => clip.clipId);
      covered += picture.covered.length;
      // The editor stage.
      const state = stage.at(ms);
      expect(state.activeVisualClipIds, `舞台 第 ${frame} 帧`).toEqual(visible);
      expect(state.activeObsCueIds, `显示来源 第 ${frame} 帧`).toEqual([...new Set(picture.shows.map(show => show.cueId))]);
      expect(state.clips.filter(entry => entry.covered).map(entry => entry.clip.id)).toEqual(picture.covered.map(clip => clip.clipId));
      // The preview drawn without OBS.
      const preview = timeline.picture(frame);
      expect(preview.camera?.id ?? null, `离线预览 第 ${frame} 帧`).toBe(picture.camera?.cueId ?? null);
      expect([...preview.clipIds].sort()).toEqual([...visible, ...heard].sort());
      // The output.
      const work = timeline.at(frame);
      expect(work.media.map(event => event.clipId).sort(), `正式播出 第 ${frame} 帧`).toEqual([...visible, ...heard].sort());
      const program = work.cues[0]?.cue.actions.find(entry => entry.kind === 'obs.setProgramScene');
      expect(program?.kind === 'obs.setProgramScene' ? program.sceneLayers ?? [program.sceneName] : picture.target.kind === 'clip' ? [picture.target.sceneName] : [],
        `正式播出的场景 第 ${frame} 帧`).toEqual(picture.target.kind === 'composition' ? picture.target.layers.map(layer => layer.sceneName) : picture.target.sceneName === null ? [] : [picture.target.sceneName]);
    }
    expect(covered).toBeGreaterThan(0);
    expect(timeline.pictureAt(12 * 30)).toMatchObject({ target: { kind: 'scene', cueId: 'wide' }, clips: [], covered: [{ clipId: 'dance' }], shows: [{ cueId: 'caption' }] });
    expect(timeline.pictureAt(33 * 30)).toMatchObject({ target: { kind: 'composition' }, camera: { cueId: 'open', held: false }, sounds: [{ clipId: 'clap-clip' }] });
  });

  it('源码里只有 scene-output-timeline.ts 推画面：别处不再有自己的盖住规则，也不用 impliedSceneEnds 推画面', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });
    const files = [...sources(join(root, 'packages')), ...sources(join(root, 'apps'))].map(path => ({ path: relative(root, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }));
    expect(files.length).toBeGreaterThan(100);
    // impliedSceneEnds: defined (and used to tidy old projects) in content-timeline.ts, read for the picture only here.
    expect(files.filter(file => /\bimpliedSceneEnds\b/.test(file.text)).map(file => file.path).sort())
      .toEqual(['packages/core/src/content-timeline.ts', 'packages/core/src/scene-output-timeline.ts']);
    expect(files.filter(file => /\bfunction stackAt\b|\bstackAt\(/.test(file.text)).map(file => file.path)).toEqual(['packages/core/src/scene-output-timeline.ts']);
    // The editor's timeline state takes the picture from the output's timeline.
    expect(files.find(file => file.path === 'packages/core/src/timeline-state.ts')?.text).toContain('pictureAt(');
  });
});
