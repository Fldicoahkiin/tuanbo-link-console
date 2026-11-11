import { expect, it } from 'vitest';
import { emptyInternalPlayerState, type InternalPlayerState } from '@tb/core/link';
import { createEmptyLinkProject, type RundownItem } from '@tb/schema';
import { KeyRouter } from '../keys/key-router';
import { editorPlayRequest, homePlayButton, homePlayPress, pressHomePlayButton } from './play-buttons';

const song = (id: string, withAudio = true): RundownItem => ({ id, title: id, enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
  ...(withAudio ? { referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 120_000 } } : {}) });
function show() {
  const project = createEmptyLinkProject('空格');
  project.rundown = [song('第一首'), song('第二首'), song('第三首'), song('第四首', false), { ...song('第五首'), enabled: false }];
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
});

/** The window's key router, with the window's play key there (useInternalPlayer) and nothing focused. */
const router = new KeyRouter(() => null);
router.register('global', () => ({ 'transport.playPause': () => undefined }));
/** The home player's play button handed to the router while the home page shows (ProjectPlayerTransport). */
const registerHomePlayButton = (onScreen: boolean, press: () => void): (() => void) =>
  router.register('home', () => ({ 'transport.playPause': () => press() }), () => onScreen);
/** Space pressed with nothing focused. */
function pressPlayButton(): void {
  router.dispatch({ code: 'Space', key: ' ', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, repeat: false, isComposing: false,
    defaultPrevented: false, preventDefault: () => undefined, target: null });
}

/** The home player, writing down what its play button asked for. */
function recorder(calls: string[]) {
  return { pause: () => { calls.push('暂停'); }, resume: () => { calls.push('继续'); }, play: (itemId: string) => { calls.push(`播放 ${itemId}`); } };
}

it('首页选中的歌没有音频或已停用时，播放按钮变灰并写明原因；空格不改播第一首，只说明原因（0.5.9）', () => {
  const project = show();
  const stopped = player('stopped', '第一首');
  for (const [id, reason] of [['第四首', '“第四首”不能播放，这首歌还没有音频。请在右侧节目属性里点“添加音频”'], ['第五首', '“第五首”不能播放，这首歌已停用。请在右侧节目属性里打开“启用”']] as const) {
    const button = homePlayButton(project, stopped, pick(project, id), true);
    // The heading shows the song picked, so the button cannot play another one.
    expect([button.selected?.id, button.target, button.unavailable]).toEqual([id, undefined, reason]);
    expect(homePlayPress(button, stopped.status)).toBeNull();
    const calls: string[] = [];
    const leave = registerHomePlayButton(true, () => { pressHomePlayButton(button, stopped.status, recorder(calls), text => calls.push(`说明：${text}`)); });
    pressPlayButton();
    leave();
    expect(calls).toEqual([`说明：${reason}`]);
  }
});

it('首页播放按钮和空格是同一个按下：停着播按钮上那首，在播暂停，暂停时继续，准备中只说明；只在首页显示时空格才按它（0.5.9）', () => {
  const project = show();
  const calls: string[] = [];
  const press = (state: InternalPlayerState): void => pressHomePlayButton(homePlayButton(project, state, pick(project, '第三首'), true), state.status, recorder(calls), text => calls.push(`说明：${text}`));
  for (const state of [player('stopped', '第一首'), player('playing', '第二首'), player('paused', '第二首'), player('preparing', '第二首')]) press(state);
  expect(calls).toEqual(['播放 第三首', '暂停', '继续', '说明：正在准备音频，点“停止”可以取消']);

  // The editor, the lighting workbench or the settings page is open: Space leaves the home button alone.
  calls.length = 0;
  const hidden = registerHomePlayButton(false, () => calls.push('首页'));
  pressPlayButton();
  hidden();
  const leave = registerHomePlayButton(true, () => calls.push('首页'));
  pressPlayButton();
  leave();
  pressPlayButton();
  expect(calls).toEqual(['首页']);
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
