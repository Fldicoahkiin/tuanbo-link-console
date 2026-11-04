import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { SceneOutputTimeline, sceneBoundaryWork, sceneOutputAt } from '@tb/core/link';
import { ManagedOutputRuntime } from '@tb/core/link';
import { compileManagedMediaTimeline } from '@tb/core/link';

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
    const runtime = new ManagedOutputRuntime(project, 'show.tblink', { executeManagedMediaEvent: () => Promise.resolve(), recordLog: () => Promise.reject(new Error('不应写日志')) });
    runtime.selectItem('song');
    const original = compileManagedMediaTimeline(project, 'song').events.find(event => event.phase === 'start')!;
    const expected = 2000 + Math.round((restored.frameNumber - original.frameNumber) * 1001 / 30);
    expect(restored.sourceOffsetMs).toBe(expected);
    expect(runtime.alignEvent(original, restored.frameNumber).sourceOffsetMs).toBe(expected);
    expect(expected - (2000 + Math.round((restored.frameNumber - original.frameNumber) * 1000 / 30))).toBeGreaterThan(500);
  });
  it('位置更新中断后按当前位置重建：只有机位切换也恢复，仍在区间内的素材按当前位置起播，间隙内起止的素材不发停止', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    item.visualLayers.unshift({ id: 'flash-layer', name: '闪现', visible: true, locked: false });
    item.referenceMediaClips.push({ ...item.referenceMediaClips[0]!, id: 'flash', layerId: 'flash-layer', startTimecode: { hours: 0, minutes: 0, seconds: 7, frames: 0 }, durationMs: 1000, sourceOffsetMs: 0 });
    const timeline = new SceneOutputTimeline(project, 'song'), events = compileManagedMediaTimeline(project, 'song').events;
    const crossed = (previous: number, frame: number) => events.filter(event => event.frameNumber > previous && event.frameNumber <= frame);
    const camera = timeline.rebuild(270, 330, [], crossed(270, 330));
    expect(camera.cues.map(entry => [entry.cue.id, entry.scheduledFrame])).toEqual([['camera', 330]]); expect(camera.media).toEqual([]);
    expect(timeline.cross(270, 330, [], crossed(270, 330))).toEqual({ cues: [], media: [] });
    const entering = timeline.rebuild(150, 200, [], crossed(150, 200));
    expect(entering.media.map(event => [event.clipId, event.phase, event.frameNumber])).toEqual([['clip', 'start', 200]]);
    expect(timeline.rebuild(200, 250, [], crossed(200, 250))).toEqual({ cues: [], media: [] });
  });
  it('同来源紧邻片段直接重新定位，真实间隙仍停止来源', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    item.cues = [];
    const first = item.referenceMediaClips[0]!;
    item.referenceMediaClips.push({ ...first, id: 'next', startTimecode: { hours: 0, minutes: 0, seconds: 30, frames: 0 }, durationMs: 5000, sourceOffsetMs: 0 });
    const events = compileManagedMediaTimeline(project, 'song').events;
    const work = sceneBoundaryWork(project, 'song', 899, 900, [], events.filter(event => event.frameNumber === 900));
    expect(work.media.map(event => [event.clipId, event.phase, event.sourceOffsetMs])).toEqual([['next', 'start', 0]]);
    item.referenceMediaClips[1]!.startTimecode.seconds = 31;
    const gapEvents = compileManagedMediaTimeline(project, 'song').events;
    const gap = sceneBoundaryWork(project, 'song', 899, 900, [], gapEvents.filter(event => event.frameNumber === 900));
    expect(gap.media.map(event => [event.clipId, event.phase])).toEqual([['clip', 'stop']]);
  });

  it('播放会话重复查询复用准备结果，切换到新修订才采用改动的机位时长', () => {
    const project = projectFixture();
    const timeline = new SceneOutputTimeline(project, 'song');
    const expected = timeline.at(450);
    expect(expected.media[0]?.clipId).toBe('clip');
    for (let frame = 451; frame < 600; frame++) expect(timeline.cross(frame - 1, frame, [], [])).toEqual({ cues: [], media: [] });
    project.rundown[0]!.cues[0] = { ...project.rundown[0]!.cues[0]!, durationMs: 10000 };
    expect(timeline.at(450).media[0]?.clipId).toBe('clip');
    expect(new SceneOutputTimeline(project, 'song').at(450).cues[0]?.cue.id).toBe('camera');
  });
  it('第二段透明素材进入和退出只改变叠加层，不重新启动持续播放的底层视频', () => {
    const project = projectFixture(), item = project.rundown[0]!;
    item.cues = [];
    project.mediaAssets.push({ ...project.mediaAssets[0]!, id: 'cards', name: '扑克牌.mov', relativePath: 'assets/cards.mov', sha256: 'b'.repeat(64), durationMs: 2200 });
    item.referenceMediaClips.push(...[0, 8].map((seconds) => ({ ...item.referenceMediaClips[0]!, id: `cards-${seconds}`, assetId: 'cards', layerId: 'camera-layer', startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs: 2200, sourceOffsetMs: 0 })));
    const events = compileManagedMediaTimeline(project, 'song').events;
    const entering = sceneBoundaryWork(project, 'song', 239, 240, [], events.filter(event => event.frameNumber === 240));
    expect(entering.media.map(event => event.clipId)).toEqual(['cards-8']);
    expect(entering.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneLayers: [events.find(event => event.clipId === 'cards-8')!.sceneName, events.find(event => event.clipId === 'clip')!.sceneName] });
    const leaving = sceneBoundaryWork(project, 'song', 305, 306, [], events.filter(event => event.frameNumber === 306));
    expect(leaving.media.map(event => [event.clipId, event.phase])).toEqual([['cards-8', 'stop']]);
    expect(leaving.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneName: events.find(event => event.clipId === 'clip')!.sceneName });
  });
  it('透明视频在机位上方时保留下方机位，并在特效结束时恢复机位', () => {
    const project = projectFixture();
    project.rundown[0]!.visualLayers.reverse();
    const work = sceneOutputAt(project, 'song', 330);
    expect(work.media).toHaveLength(1);
    expect(work.media[0]?.deferSceneSwitch).toBe(true);
    expect(work.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneLayers: [work.media[0]?.sceneName, '拉腿机位'] });
    const runtime = new ManagedOutputRuntime(project, 'show.tblink', { executeManagedMediaEvent: () => Promise.resolve(), recordLog: () => Promise.reject(new Error('不应写日志')) });
    runtime.selectItem('song');
    expect(runtime.alignEvent(work.media[0]!, 330)).toMatchObject({ deferSceneSwitch: true, sourceOffsetMs: 7000 });
    project.rundown[0]!.referenceMediaClips[0]!.durationMs = 6000;
    const ended = sceneBoundaryWork(project, 'song', 359, 360, [], [{ ...work.media[0]!, phase: 'stop', frameNumber: 360 }]);
    expect(ended.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneName: '拉腿机位' });
    expect(ended.media.every(event => event.phase === 'stop')).toBe(true);
  });
  it('10–15 秒覆盖视频，15 秒恢复视频第 11 秒，不能从头或暂停处继续', () => {
    const project = projectFixture();
    expect(sceneOutputAt(project, 'song', 299).media[0]?.clipId).toBe('clip');
    expect(sceneOutputAt(project, 'song', 300).cues[0]?.cue.id).toBe('camera');
    const work = sceneBoundaryWork(project, 'song', 449, 450, [], []);
    expect(work.cues).toEqual([]); expect(work.media[0]?.clipId).toBe('clip');
    const runtime = new ManagedOutputRuntime(project, 'show.tblink', { executeManagedMediaEvent: () => Promise.resolve(), recordLog: () => Promise.reject(new Error('不应写日志')) });
    runtime.selectItem('song');
    expect(runtime.alignEvent(work.media[0]!, 450).sourceOffsetMs).toBe(11000);
    expect(sceneBoundaryWork(project, 'song', 450, 451, [], [])).toEqual({ media: [], cues: [] });
  });
  it('从机位中间继续保持机位；定位到机位结束之后只恢复视频、不补发 MIDI', () => {
    const project = projectFixture();
    expect(sceneOutputAt(project, 'song', 360).cues[0]?.cue.actions.map((action) => action.kind)).toEqual(['obs.setProgramScene']);
    expect(sceneOutputAt(project, 'song', 500).media).toHaveLength(1);
    expect(sceneOutputAt(project, 'song', 500).cues).toEqual([]);
  });
  it('拖长机位后按新结束点恢复；隐藏机位轨道后保持视频', () => {
    const project = projectFixture(); project.rundown[0]!.cues[0]!.durationMs = 8000;
    expect(sceneOutputAt(project, 'song', 539).cues).toHaveLength(1);
    expect(sceneBoundaryWork(project, 'song', 539, 540, [], []).media).toHaveLength(1);
    project.rundown[0]!.visualLayers[0]!.visible = false;
    expect(sceneOutputAt(project, 'song', 400).media).toHaveLength(1);
  });
});


describe('无时长场景与后续素材交接', () => {
  it('上层无时长场景在后续视频开始时让出画面', () => {
    const project = projectFixture();
    const cue = project.rundown[0]!.cues[0]!;
    delete cue.durationMs;
    cue.timecode = { hours: 0, minutes: 0, seconds: 2, frames: 0 };
    expect(sceneOutputAt(project, 'song', 179).cues[0]?.cue.id).toBe('camera');
    expect(sceneOutputAt(project, 'song', 180).media[0]?.clipId).toBe('clip');
    expect(sceneOutputAt(project, 'song', 300).cues).toEqual([]);
  });
  it('明确设置时长的场景仍按图层优先级覆盖视频，到结束帧恢复', () => {
    const project = projectFixture();
    project.rundown[0]!.cues[0]!.timecode = { hours: 0, minutes: 0, seconds: 2, frames: 0 };
    expect(sceneOutputAt(project, 'song', 180).cues[0]?.cue.id).toBe('camera');
    expect(sceneOutputAt(project, 'song', 210).media[0]?.clipId).toBe('clip');
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
    const work = sceneOutputAt(project, 'song', 330);
    expect(work.media.map(event => event.clipId)).toEqual(['applause']);
    expect(work.cues[0]?.cue.actions[0]).toMatchObject({ kind: 'obs.setProgramScene', sceneLayers: ['拉腿机位', sound.sceneName] });
    expect(new SceneOutputTimeline(project, 'song').picture(330)).toMatchObject({ camera: { id: 'camera' }, clipIds: ['applause'] });
  });
  it('机位结束后只剩音效时保留机位画面，结束那一帧不发多余动作', () => {
    const project = withSound('media');
    const sound = compileManagedMediaTimeline(project, 'song').events.find(event => event.clipId === 'applause')!;
    expect(sceneOutputAt(project, 'song', 500).cues[0]?.cue.actions[0]).toMatchObject({ sceneLayers: ['拉腿机位', sound.sceneName] });
    expect(sceneBoundaryWork(project, 'song', 449, 450, [], [])).toEqual({ cues: [], media: [] });
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
