import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { SceneOutputTimeline } from '@tb/core/link';
import { alignManagedMediaEvent, compileManagedMediaTimeline, type ManagedMediaEvent } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

/** The output work at one frame, from a fresh timeline of this revision. */
const outputAt = (project: LinkProject, itemId: string, frame: number) => new SceneOutputTimeline(project, itemId).at(frame);
/** A clip start moved to `frame`, from the song's compiled start of that clip. */
const aligned = (project: LinkProject, event: ManagedMediaEvent, frame: number) => alignManagedMediaEvent(event,
  compileManagedMediaTimeline(project, 'song').events.find(candidate => candidate.id === event.id) ?? event, frame, project.timebase.frameRate);

function projectFixture() {
  return parseLinkProject({ ...createEmptyLinkProject('插入机位'), obsOutputMode: 'scenes', mediaAssets: [{ id: 'video', name: '舞蹈.mp4', kind: 'video', relativePath: 'assets/dance.mp4', sha256: 'a'.repeat(64), byteLength: 10, durationMs: 40000, width: 1080, height: 1920 }], rundown: [{
    id: 'song', title: '舞蹈', visualLayers: [{ id: 'camera-layer', name: '机位', visible: true, locked: false }, { id: 'media', name: '视频', visible: true, locked: false }],
    referenceMediaClips: [{ id: 'clip', assetId: 'video', label: '舞蹈', layerId: 'media', startTimecode: { hours: 0, minutes: 0, seconds: 6, frames: 0 }, durationMs: 24000, sourceOffsetMs: 2000 }],
    cues: [{ id: 'camera', name: '临时机位', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, durationMs: 5000, actions: [{ id: 'scene', kind: 'obs.setProgramScene', label: '切机位', sceneName: '拉腿机位' }, { id: 'light', label: '灯光', kind: 'midi.noteOn', portProfileId: 'lighting', channel: 1, note: 60, velocity: 100 }] }]
  }] });
}

describe('机位片段结束恢复素材', () => {
  it('倒序定位保留长机位覆盖短机位后的恢复，同帧场景及结束边界不混淆', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    const camera = item.cues[0]!;
    item.referenceMediaClips = [];
    item.visualLayers.unshift({ id: 'top', name: '插入机位', visible: true, locked: false });
    item.cues = [
      { ...camera, id: 'short', layerId: 'top', durationMs: 1000 },
      { ...camera, id: 'long', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, durationMs: 30000 },
      { ...camera, id: 'same-time-point', layerId: 'media', durationMs: undefined }
    ];
    // The song runs past the long camera, so the switch with no length holds after it.
    item.referenceAudio = { assetId: 'song-audio', relativePath: 'assets/song.wav', sha256: 'b'.repeat(64), durationMs: 40_000 };
    const timeline = new SceneOutputTimeline(project, 'song');
    expect(timeline.at(330).cues[0]?.cue.id).toBe('long');
    expect(timeline.at(300).cues[0]?.cue.id).toBe('short');
    expect(timeline.at(299).cues[0]?.cue.id).toBe('long');
    expect(timeline.at(0)).toEqual({ cues: [], media: [] });
    expect(timeline.at(930).cues[0]?.cue.id).toBe('same-time-point');
  });
  it('29.97df 的恢复及预备偏移按实际帧时长换算，不把30当实际帧率累计误差', () => {
    const project = projectFixture(); project.timebase.frameRate = '29.97df';
    const item = project.rundown[0]!;
    item.referenceMediaClips[0]!.durationMs = 3600000;
    const camera = item.cues[0]!;
    camera.timecode = { hours: 0, minutes: 9, seconds: 0, frames: 2 }; camera.durationMs = 60000;
    const timeline = new SceneOutputTimeline(project, 'song');
    const restored = timeline.preloadEntries().at(-1)!;
    const original = compileManagedMediaTimeline(project, 'song').events.find(event => event.phase === 'start')!;
    const expected = 2000 + Math.round((restored.frameNumber - original.frameNumber) * 1001 / 30);
    expect(restored.sourceOffsetMs).toBe(expected);
    expect(aligned(project, original, restored.frameNumber).sourceOffsetMs).toBe(expected);
    expect(expected - (2000 + Math.round((restored.frameNumber - original.frameNumber) * 1000 / 30))).toBeGreaterThan(500);
  });
  it('播放会话重复查询复用准备结果，切换到新修订才采用改动的机位时长', () => {
    const project = projectFixture();
    const timeline = new SceneOutputTimeline(project, 'song');
    const expected = timeline.at(450);
    expect(expected.media[0]?.clipId).toBe('clip');
    project.rundown[0]!.cues[0] = { ...project.rundown[0]!.cues[0]!, durationMs: 10000 };
    expect(timeline.at(450).media[0]?.clipId).toBe('clip');
    expect(new SceneOutputTimeline(project, 'song').at(450).cues[0]?.cue.id).toBe('camera');
  });
  it('透明视频在机位上方时保留下方机位，并在特效结束时恢复机位', () => {
    const project = projectFixture();
    project.rundown[0]!.visualLayers.reverse();
    const work = outputAt(project, 'song', 330);
    expect(work.media).toHaveLength(1);
    expect(work.media[0]?.deferSceneSwitch).toBe(true);
    expect(work.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneLayers: [work.media[0]?.sceneName, '拉腿机位'] });
    expect(aligned(project, work.media[0]!, 330)).toMatchObject({ deferSceneSwitch: true, sourceOffsetMs: 7000 });
  });
  it('10–15 秒覆盖视频，15 秒恢复视频第 11 秒，不能从头或暂停处继续', () => {
    const project = projectFixture();
    expect(outputAt(project, 'song', 299).media[0]?.clipId).toBe('clip');
    expect(outputAt(project, 'song', 300).cues[0]?.cue.id).toBe('camera');
    const work = outputAt(project, 'song', 450);
    expect(work.cues).toEqual([]); expect(work.media[0]?.clipId).toBe('clip');
    expect(aligned(project, work.media[0]!, 450).sourceOffsetMs).toBe(11000);
  });
  it('从机位中间继续保持机位；定位到机位结束之后只恢复视频、不补发 MIDI', () => {
    const project = projectFixture();
    expect(outputAt(project, 'song', 360).cues[0]?.cue.actions.map((action) => action.kind)).toEqual(['obs.setProgramScene']);
    expect(outputAt(project, 'song', 500).media).toHaveLength(1);
    expect(outputAt(project, 'song', 500).cues).toEqual([]);
  });
  it('拖长机位后按新结束点恢复；隐藏机位轨道后保持视频', () => {
    const project = projectFixture(); project.rundown[0]!.cues[0]!.durationMs = 8000;
    expect(outputAt(project, 'song', 539).cues).toHaveLength(1);
    project.rundown[0]!.visualLayers[0]!.visible = false;
    expect(outputAt(project, 'song', 400).media).toHaveLength(1);
  });
});


describe('无时长场景与后续素材交接', () => {
  it('上层无时长场景在后续视频开始时让出画面', () => {
    const project = projectFixture();
    const cue = project.rundown[0]!.cues[0]!;
    delete cue.durationMs;
    cue.timecode = { hours: 0, minutes: 0, seconds: 2, frames: 0 };
    expect(outputAt(project, 'song', 179).cues[0]?.cue.id).toBe('camera');
    expect(outputAt(project, 'song', 180).media[0]?.clipId).toBe('clip');
    expect(outputAt(project, 'song', 300).cues).toEqual([]);
  });
  it('明确设置时长的场景仍按图层优先级覆盖视频，到结束帧恢复', () => {
    const project = projectFixture();
    project.rundown[0]!.cues[0]!.timecode = { hours: 0, minutes: 0, seconds: 2, frames: 0 };
    expect(outputAt(project, 'song', 180).cues[0]?.cue.id).toBe('camera');
    expect(outputAt(project, 'song', 210).media[0]?.clipId).toBe('clip');
  });
});

describe('上层盖住下层，音效不算画面', () => {
  function withSound(layerId: string) {
    const project = projectFixture(), item = project.rundown[0]!;
    project.mediaAssets.push({ id: 'sound', name: '掌声.wav', kind: 'audio', folderId: null, relativePath: 'assets/applause.wav', sha256: 'c'.repeat(64), byteLength: 10, durationMs: 40000 });
    item.referenceMediaClips = [{ ...item.referenceMediaClips[0]!, id: 'applause', assetId: 'sound', label: '掌声', layerId, startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 30000, sourceOffsetMs: 0 }];
    return project;
  }
  it('机位下面轨道的音效照常出声，不被机位盖掉', () => {
    const project = withSound('media');
    const sound = compileManagedMediaTimeline(project, 'song').events.find(event => event.clipId === 'applause')!;
    const work = outputAt(project, 'song', 330);
    expect(work.media.map(event => event.clipId)).toEqual(['applause']);
    expect(work.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneLayers: ['拉腿机位', sound.sceneName] });
    expect(new SceneOutputTimeline(project, 'song').picture(330)).toMatchObject({ camera: { id: 'camera' }, clipIds: ['applause'] });
  });
  it('机位结束后只剩音效时保留机位画面，结束那一帧不发多余动作', () => {
    const project = withSound('media');
    const sound = compileManagedMediaTimeline(project, 'song').events.find(event => event.clipId === 'applause')!;
    expect(outputAt(project, 'song', 500).cues[0]?.cue.actions[0]).toMatchObject({ sceneLayers: ['拉腿机位', sound.sceneName] });
    expect(new SceneOutputTimeline(project, 'song').picture(500)).toMatchObject({ camera: { id: 'camera' }, clipIds: ['applause'] });
  });
  it('没连 OBS 的预览和输出一致：两段视频重叠时都显示，视频在机位上方时机位垫在下面', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    item.cues = [];
    item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'overlay', layerId: 'camera-layer', startTimecode: { hours: 0, minutes: 0, seconds: 8, frames: 0 }, durationMs: 4000 });
    const timeline = new SceneOutputTimeline(project, 'song');
    expect(timeline.at(300).media.map(event => event.clipId)).toEqual(['overlay', 'clip']);
    expect(timeline.picture(300)).toEqual({ camera: null, clipIds: ['overlay', 'clip'] });
    expect(timeline.picture(400)).toEqual({ camera: null, clipIds: ['clip'] });
    const covered = projectFixture();
    covered.rundown[0]!.visualLayers.reverse();
    expect(new SceneOutputTimeline(covered, 'song').picture(330)).toMatchObject({ camera: { id: 'camera' }, clipIds: ['clip'] });
    expect(new SceneOutputTimeline(projectFixture(), 'song').picture(330)).toMatchObject({ camera: { id: 'camera' }, clipIds: [] });
  });
});

describe('完整场景定位', () => {
  it('只恢复最后有效场景，不补发历史 MIDI，不切到未来或停用的场景', () => {
    const project = parseLinkProject({ ...createEmptyLinkProject('场景定位'), rundown: [{ id: 'song', title: '歌', cues: [0, 3, 5, 9].map((second) => ({
      id: `cue-${second}`, name: `场景${second}`, enabled: second !== 5, timecode: { hours: 0, minutes: 0, seconds: second, frames: 0 },
      actions: [{ id: `scene-${second}`, label: '场景', kind: 'obs.setProgramScene', sceneName: `Scene ${second}` }, { id: `midi-${second}`, label: '灯光', kind: 'midi.noteOn', portProfileId: 'lights', channel: 1, note: 60, velocity: 127 }]
    })) }] });
    const result = outputAt(project, 'song', 7 * 30);
    expect(result.media).toEqual([]); expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.cue.actions).toEqual([{ id: 'scene-3', label: '场景', kind: 'obs.setProgramScene', sceneName: 'Scene 3' }]);
  });
});

describe('每段画面实际播出的帧', () => {
  it('上层机位盖住的那段视频不算播出，机位只算自己的长度，隐藏轨道整段不播', () => {
    const project = projectFixture();
    const airtime = new SceneOutputTimeline(project, 'song').airtime();
    expect(airtime.get('media:clip')).toEqual([{ start: 180, end: 300 }, { start: 450, end: 900 }]);
    expect(airtime.get('cue:camera')).toEqual([{ start: 300, end: 450 }]);
    project.rundown[0]!.visualLayers[0]!.visible = false;
    const hidden = new SceneOutputTimeline(project, 'song').airtime();
    expect(hidden.get('media:clip')).toEqual([{ start: 180, end: 900 }]);
    expect(hidden.has('cue:camera')).toBe(false);
  });
  it('整段被上层机位盖住的机位记为空，声音不被盖住', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    const camera = item.cues[0]!;
    item.visualLayers.push({ id: 'under', name: '底层机位', visible: true, locked: false });
    item.cues.push({ ...camera, id: 'under-camera', layerId: 'under', timecode: { hours: 0, minutes: 0, seconds: 11, frames: 0 }, durationMs: 2000 });
    project.mediaAssets.push({ id: 'sound', name: '掌声.wav', kind: 'audio', folderId: null, relativePath: 'assets/clap.wav', sha256: 'c'.repeat(64), byteLength: 10, durationMs: 3000 });
    item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'clap', assetId: 'sound', label: '掌声', layerId: 'under', startTimecode: { hours: 0, minutes: 0, seconds: 9, frames: 0 }, durationMs: 2000, sourceOffsetMs: 0 });
    const airtime = new SceneOutputTimeline(project, 'song').airtime();
    expect(airtime.get('cue:under-camera')).toEqual([]);
    expect(airtime.get('media:clap')).toEqual([{ start: 270, end: 330 }]);
  });
});

describe('pictureAt：这一帧该显示什么', () => {
  const scene = (project: LinkProject) => compileManagedMediaTimeline(project, 'song').events.find(event => event.clipId === 'clip')!.sceneName;
  it('素材、机位盖住素材、机位结束后留着、开头什么都没有', () => {
    const project = projectFixture(), timeline = new SceneOutputTimeline(project, 'song');
    expect(timeline.pictureAt(0)).toEqual({ frame: 0, target: { kind: 'hold', cueId: null, sceneName: null }, camera: null, clips: [], covered: [], sounds: [], shows: [] });
    expect(timeline.pictureAt(210)).toMatchObject({ target: { kind: 'clip', clipId: 'clip', sceneName: scene(project) }, camera: null,
      clips: [{ clipId: 'clip', offsetMs: 3000, layerId: 'media', sceneName: scene(project) }], covered: [] });
    // 10–15 s the camera is the whole frame; the video under it keeps its place for the reveal.
    expect(timeline.pictureAt(330)).toMatchObject({ target: { kind: 'scene', cueId: 'camera', sceneName: '拉腿机位' }, camera: { cueId: 'camera', held: false },
      clips: [], covered: [{ clipId: 'clip', offsetMs: 7000 }] });
    expect(timeline.pictureAt(450)).toMatchObject({ target: { kind: 'clip', clipId: 'clip' }, clips: [{ offsetMs: 11000 }], covered: [] });
    // After the video ends nothing has a picture: the last camera stays on program.
    expect(timeline.pictureAt(950)).toMatchObject({ target: { kind: 'hold', cueId: 'camera', sceneName: '拉腿机位' }, camera: { cueId: 'camera', held: true }, clips: [] });
    expect(timeline.cutPoints()).toEqual([180, 300, 450, 900]);
  });
  it('没有时长的机位盖到下一个画面开始，没有下一个就到节目结尾', () => {
    const project = projectFixture(); delete project.rundown[0]!.cues[0]!.durationMs;
    const timeline = new SceneOutputTimeline(project, 'song');
    expect(timeline.pictureAt(600)).toMatchObject({ target: { kind: 'scene', cueId: 'camera' }, covered: [{ clipId: 'clip' }] });
    expect(timeline.cutPoints()).toEqual([180, 300, 900]);
  });
  it('显示来源按自己的区间开着（含开始帧、不含结束帧），停用或在隐藏轨道上的不开，切点里有它的起止', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    item.cues.push({ id: 'caption', name: '字幕', enabled: true, notes: '', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 }, durationMs: 1000,
      actions: [{ id: 'caption-show', label: '字幕', kind: 'obs.setSceneItemEnabled', sceneName: '拉腿机位', sourceName: '字幕', enabled: true }] });
    const timeline = new SceneOutputTimeline(project, 'song');
    expect(timeline.pictureAt(59).shows).toEqual([]);
    expect(timeline.pictureAt(60).shows).toEqual([{ cueId: 'caption', actionId: 'caption-show', sceneName: '拉腿机位', sourceName: '字幕', layerId: 'camera-layer' }]);
    expect(timeline.pictureAt(89).shows).toHaveLength(1);
    expect(timeline.pictureAt(90).shows).toEqual([]);
    expect(timeline.cutPoints()).toEqual([60, 90, 180, 300, 450, 900]);
    item.cues.at(-1)!.enabled = false;
    expect(new SceneOutputTimeline(project, 'song').pictureAt(70).shows).toEqual([]);
    item.cues.at(-1)!.enabled = true; item.visualLayers[0]!.visible = false;
    expect(new SceneOutputTimeline(project, 'song').pictureAt(70).shows).toEqual([]);
  });
  it('切开的同一段视频接着播：同一个解码器、紧挨着、素材位置接得上才算', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    item.cues = [];
    item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'rest', startTimecode: { hours: 0, minutes: 0, seconds: 30, frames: 0 }, durationMs: 5000, sourceOffsetMs: 26000 });
    expect(new SceneOutputTimeline(project, 'song').pictureAt(900).clips).toMatchObject([{ clipId: 'rest', offsetMs: 26000, continuesFrom: 'clip' }]);
    item.referenceMediaClips[1]!.sourceOffsetMs = 0;
    expect(new SceneOutputTimeline(project, 'song').pictureAt(900).clips[0]?.continuesFrom).toBeUndefined();
  });
  it('picture、airtime、at 都从 pictureAt 推出来：音效在机位下面也照常出声', () => {
    const project = projectFixture();
    project.mediaAssets.push({ id: 'sound', name: '掌声.wav', kind: 'audio', folderId: null, relativePath: 'assets/applause.wav', sha256: 'c'.repeat(64), byteLength: 10, durationMs: 40000 });
    project.rundown[0]!.referenceMediaClips.push({ ...project.rundown[0]!.referenceMediaClips[0]!, id: 'applause', assetId: 'sound', label: '掌声', startTimecode: { hours: 0, minutes: 0, seconds: 11, frames: 0 }, durationMs: 2000, sourceOffsetMs: 0 });
    const timeline = new SceneOutputTimeline(project, 'song');
    expect(timeline.pictureAt(340)).toMatchObject({ target: { kind: 'composition', layers: [{ sceneName: '拉腿机位' }, {}] }, camera: { cueId: 'camera', held: false },
      sounds: [{ clipId: 'applause' }], covered: [{ clipId: 'clip' }] });
    expect(timeline.picture(340)).toMatchObject({ camera: { id: 'camera' }, clipIds: ['applause'] });
    expect(timeline.at(340).media.map(event => event.clipId)).toEqual(['applause']);
    expect(timeline.airtime().get('media:applause')).toEqual([{ start: 330, end: 390 }]);
  });
});
