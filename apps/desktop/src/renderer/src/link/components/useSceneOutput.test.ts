import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkCue, type LinkProject, type ProgramPlayerState } from '@tb/schema';
import { moveContentCommand, SceneOutputTimeline, withContentTimeline } from '@tb/core/link';
import { useSceneOutput } from './useSceneOutput';

const at = (seconds: number) => ({ hours: 0, minutes: 0, seconds, frames: 0 });
const camera = (id: string, seconds: number): LinkCue => ({
  id, name: `机位 ${id}`, enabled: true, notes: '', timecode: at(seconds), durationMs: 2_000, layerId: 'cameras',
  actions: [{ id: `${id}-scene`, label: `切到 ${id}`, kind: 'obs.setProgramScene', sceneName: `机位 ${id}` }]
});
/** The song as 联动台播放 started it: camera a at 2 s, camera b at 8 s. */
function started(playbackSource: LinkProject['playbackSource'] = 'internal'): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource, obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '第三首', enabled: true, notes: '',
    visualLayers: [{ id: 'cameras', name: '轨道 1', visible: true, locked: false }], cues: [camera('a', 2), camera('b', 8)] }] });
}
/** Camera b moved to 12 s in the editor. */
const moved = (project: LinkProject): LinkProject => withContentTimeline(moveContentCommand('song', { kind: 'cue', id: 'b' }, 12_000, { track: 'cameras' })).execute(project);
const airtime = (project: LinkProject) => new SceneOutputTimeline(project, 'song').airtime();

type Output = ReturnType<typeof useSceneOutput>;
function sceneOutput(project: LinkProject, itemId: string | null, state: Pick<ProgramPlayerState, 'status' | 'itemId'>, playbackProject: LinkProject | null,
  { outdated = false, connected = true } = {}): Output {
  const result: Output[] = [];
  function Harness(): null {
    result.push(useSceneOutput(project, itemId, 9_000, connected, { state, outdated }, playbackProject));
    return null;
  }
  renderToString(createElement(Harness));
  return result[0]!;
}

describe('编辑器按 OBS 在播的那一版标时间线', () => {
  it('播放中挪了机位：正在播出按开始播放那一版，变暗按这里的时间线，挪过的等重播', () => {
    const playing = started(), editing = moved(playing);
    const output = sceneOutput(editing, 'song', { status: 'playing', itemId: 'song' }, playing);
    expect(output.marks.onAirtime).toEqual(airtime(playing));
    expect(output.airtime).toEqual(airtime(editing));
    expect([...output.marks.pending.changed]).toEqual(['cue:b']);
    expect(output.marks.notice?.text).toBe('播放中改了 1 处，停下重播才生效');
  });

  it('界面重新加载后接回的节目对不上：暂停时也写无法确认，不标正在播出', () => {
    const reopened = moved(started());
    const output = sceneOutput(reopened, 'song', { status: 'paused', itemId: 'song' }, reopened, { outdated: true });
    expect(output.marks.onAirtime).toBeNull();
    expect(output.marks.pending.changed.size).toBe(0);
    expect(output.marks.notice?.text).toBe('无法确认 OBS 按哪一版时间线在播');
  });

  it('停止、跟随 P1、灯光工作台都按这里的时间线，没有提示', () => {
    const playing = started(), editing = moved(playing);
    const stopped = sceneOutput(editing, 'song', { status: 'stopped', itemId: 'song' }, playing, { outdated: true });
    expect(stopped.marks.onAirtime).toEqual(airtime(editing)); expect(stopped.marks.notice).toBeNull();
    const following = moved(started('p1'));
    const p1 = sceneOutput(following, 'song', { status: 'playing', itemId: 'song' }, started('p1'));
    expect(p1.marks.onAirtime).toEqual(airtime(following)); expect(p1.marks.notice).toBeNull();
    const lighting = sceneOutput(editing, null, { status: 'playing', itemId: 'song' }, playing);
    expect(lighting.marks.notice).toBeNull(); expect(lighting.marks.onAirtime).toEqual(new Map());
  });

  it('连着 OBS 时不画离线预览；没连时按这里的时间线画播放头处的画面', () => {
    const project = started();
    expect(sceneOutput(project, 'song', { status: 'stopped', itemId: null }, project).preview).toBeNull();
    expect(sceneOutput(project, 'song', { status: 'stopped', itemId: null }, project, { connected: false }).preview?.scene).toEqual({ cueId: 'b', sceneName: '机位 b' });
  });
});
