import { expect, it } from 'vitest';
import { emptyInternalPlayerState, type InternalPlayerState } from '@tb/core/link';
import { createEmptyLinkProject, type RundownItem } from '@tb/schema';
import { editorPlayRequest, homePlayButton, homePlayPress } from './play-buttons';

const song = (id: string, withAudio = true): RundownItem => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
  ...(withAudio ? { referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 120_000 } } : {}) });
function show() {
  const project = createEmptyLinkProject('空格');
  project.rundown = [song('第一首'), song('第二首'), song('第三首'), song('没有音频', false)];
  return project;
}
const player = (status: InternalPlayerState['status'], itemId: string | null): InternalPlayerState => ({ ...emptyInternalPlayerState, status, itemId });
const pick = (project: ReturnType<typeof show>, id: string): RundownItem => {
  const item = project.rundown.find(entry => entry.id === id);
  if (!item) throw new Error(`没有 ${id}`);
  return item;
};

it('首页停着时，空格播首页播放按钮上的那首：节目单里选中的歌，不是上次播过的那首（0.5.9）', () => {
  const project = show();
  // 第一首 played last; the operator picked 第三首 in the list.
  const stopped = player('stopped', '第一首');
  const button = homePlayButton(project, stopped, pick(project, '第三首'), true);
  expect(button.target?.id).toBe('第三首');
  expect(homePlayPress(button, stopped.status)).toEqual({ kind: 'play', itemId: '第三首' });
  // Nothing picked: the button shows the song played last, and Space plays that one, the same as the button.
  expect(homePlayPress(homePlayButton(project, stopped, null, true), stopped.status)).toEqual({ kind: 'play', itemId: '第一首' });
  // A song without audio cannot play: the button shows the first one that can, and Space plays that.
  expect(homePlayPress(homePlayButton(project, stopped, pick(project, '没有音频'), true), stopped.status)).toEqual({ kind: 'play', itemId: '第一首' });
});

it('首页在播时空格暂停，暂停时继续；准备中和播放器没准备好时空格不起作用，不会重新准备（0.5.9）', () => {
  const project = show();
  const playing = player('playing', '第二首'), paused = player('paused', '第二首'), preparing = player('preparing', '第二首');
  expect(homePlayPress(homePlayButton(project, playing, pick(project, '第三首'), true), playing.status)).toEqual({ kind: 'pause' });
  expect(homePlayPress(homePlayButton(project, paused, pick(project, '第三首'), true), paused.status)).toEqual({ kind: 'resume' });
  const waiting = homePlayButton(project, preparing, pick(project, '第三首'), true);
  expect(waiting.unavailable).toBe('正在准备音频，点“停止”可以取消');
  expect(homePlayPress(waiting, preparing.status)).toBeNull();
  expect(homePlayPress(homePlayButton(project, player('stopped', null), pick(project, '第三首'), false), 'stopped')).toBeNull();
  expect(homePlayPress(homePlayButton(createEmptyLinkProject('空节目单'), player('stopped', null), null, true), 'stopped')).toBeNull();
});

it('编辑器和灯光工作台：空格从播放头播这首，不早于这首的起点；暂停后继续；准备中不起作用（0.5.9）', () => {
  // Stopped, or another song is on: play this song from the playhead.
  expect(editorPlayRequest(true, 'stopped', false, 0, 42_000)).toEqual({ kind: 'play', positionMs: 42_000 });
  expect(editorPlayRequest(true, 'paused', false, 0, 3_000)).toEqual({ kind: 'play', positionMs: 3_000 });
  expect(editorPlayRequest(true, 'stopped', false, 5_000, 1_000)).toEqual({ kind: 'play', positionMs: 5_000 });
  // This song is paused: go on from where it paused.
  expect(editorPlayRequest(true, 'paused', true, 0, 3_000)).toEqual({ kind: 'resume' });
  // Pausing pauses this song only, never another one that is on.
  expect(editorPlayRequest(false, 'playing', true, 0, 3_000)).toEqual({ kind: 'pause' });
  expect(editorPlayRequest(false, 'playing', false, 0, 3_000)).toBeNull();
  // Being prepared: a second press would start the preparation over.
  expect(editorPlayRequest(true, 'preparing', true, 0, 3_000)).toBeNull();
  expect(editorPlayRequest(true, 'preparing', false, 0, 3_000)).toBeNull();
  expect(editorPlayRequest(false, 'preparing', true, 0, 3_000)).toBeNull();
});
