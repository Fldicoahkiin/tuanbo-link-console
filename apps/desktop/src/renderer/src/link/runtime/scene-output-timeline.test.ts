import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { sceneBoundaryWork, sceneOutputAt } from './scene-output-timeline';
import { ManagedOutputRuntime } from './managed-output-runtime';

function projectFixture() {
  return parseLinkProject({ ...createEmptyLinkProject('插入机位'), obsOutputMode: 'scenes', mediaAssets: [{ id: 'video', name: '舞蹈.mp4', kind: 'video', relativePath: 'assets/dance.mp4', sha256: 'a'.repeat(64), byteLength: 10, durationMs: 40000, width: 1080, height: 1920 }], rundown: [{
    id: 'song', title: '舞蹈', visualLayers: [{ id: 'camera-layer', name: '机位', visible: true, locked: false }, { id: 'media', name: '视频', visible: true, locked: false }],
    referenceMediaClips: [{ id: 'clip', assetId: 'video', label: '舞蹈', layerId: 'media', startTimecode: { hours: 0, minutes: 0, seconds: 6, frames: 0 }, durationMs: 24000, sourceOffsetMs: 2000 }],
    cues: [{ id: 'camera', name: '临时机位', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, durationMs: 5000, actions: [{ id: 'scene', kind: 'obs.setProgramScene', label: '切机位', sceneName: '拉腿机位' }, { id: 'light', label: '灯光', kind: 'midi.noteOn', portProfileId: 'lighting', channel: 1, note: 60, velocity: 100 }] }]
  }] });
}

describe('机位片段结束恢复素材', () => {
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
