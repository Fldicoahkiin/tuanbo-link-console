import { describe, expect, it, vi } from 'vitest';
import { emptyInternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type NativeProgramAttachment, type ProgramPlayerState } from '@tb/schema';
import { followAudioConfiguration, openAnswer, playsOutdated, reopensShown, type OpenAnswer } from './program-attachment';
import { RemoteNativeProgramPlayer } from './runtime/remote-native-program-player';
import { pictureOnAir } from './view-models/picture-on-air';

/** A controller as far as the answer goes: what it says once the program answered its open. */
const controller = (outdated: boolean) => ({ outdated });

describe('后台节目答复打开以后，界面才知道它在播哪一版', () => {
  it('答复记下当时这个控制器说的：接回的节目是不是另一版', () => {
    const taken = controller(true), opened = controller(false);
    expect(openAnswer(taken)).toEqual({ controller: taken, outdated: true });
    expect(openAnswer(opened)).toEqual({ controller: opened, outdated: false });
    expect(playsOutdated(taken, openAnswer(taken))).toBe(true);
    expect(playsOutdated(opened, openAnswer(opened))).toBe(false);
  });

  it('还没答复时不知道（null），不当成同一版；没有控制器时也不知道', () => {
    expect(playsOutdated(controller(false), null)).toBeNull();
    expect(playsOutdated(null, null)).toBeNull();
  });

  it('换了控制器以后，上一个控制器听到的答复不算，等这个控制器自己的答复', () => {
    const earlier = controller(true), current = controller(false);
    expect(playsOutdated(current, openAnswer(earlier))).toBeNull();
    expect(playsOutdated(null, openAnswer(earlier))).toBeNull();
  });
});

describe('评审场景：界面重新加载后接回还在播的节目，后台先发状态、后答复打开', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', rundown: [{ id: 'song', title: '第三首' }] });

  /** The real controller, wired as useInternalPlayer wires it; the program has not answered the open yet. */
  function reopenedWindow() {
    let answerOpen!: (attachment: NativeProgramAttachment) => void;
    const api = {
      openNativeProgram: vi.fn<LinkDesktopApi['openNativeProgram']>(() => new Promise(resolve => { answerOpen = resolve; })),
      controlNativeProgram: vi.fn<LinkDesktopApi['controlNativeProgram']>(() => Promise.resolve()),
      onNativeProgramEvent: vi.fn<LinkDesktopApi['onNativeProgramEvent']>(() => vi.fn()),
      onNativePlaybackStatus: vi.fn<LinkDesktopApi['onNativePlaybackStatus']>(() => vi.fn())
    };
    let state: Pick<ProgramPlayerState, 'status' | 'itemId'> = emptyInternalPlayerState, answer: OpenAnswer<RemoteNativeProgramPlayer> | null = null;
    const controller: RemoteNativeProgramPlayer = new RemoteNativeProgramPlayer(project, 'C:/show/现场.tblink', 1, {
      configuration: () => ({ outputDeviceId: 'default', mtcPortName: null }), changed: next => { state = next; }, notice: vi.fn(),
      attached: () => { answer = openAnswer(controller); } }, api, vi.fn());
    const ownerId = api.openNativeProgram.mock.calls[0]![0].ownerId;
    return {
      /** The program kept playing over the reload: it sends its state first. */
      playing: () => api.onNativeProgramEvent.mock.calls[0]![0]({ version: 1, ownerId, sequence: 1, state: { ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 12_500 },
        clock: { positionMs: 12_500, durationMs: 20_000, ready: true, playing: true, seeking: false }, currentCueId: null }),
      answer: async (attachment: NativeProgramAttachment) => { answerOpen(attachment); await new Promise(resolve => setTimeout(resolve, 0)); },
      onAir: () => pictureOnAir('song', true, { state, project, outdated: playsOutdated(controller, answer) })
    };
  }

  it('答复前写正在确认；答复是另一版写界面重新加载过；答复是同一版才按这版标', async () => {
    const outdated = reopenedWindow(), adopted = reopenedWindow();
    for (const window of [outdated, adopted]) {
      window.playing();
      expect(window.onAir()).toEqual({ kind: 'unconfirmed', reason: '正在确认联动台播放在播哪一版', waiting: true });
    }
    await outdated.answer('outdated'); await adopted.answer('adopted');
    expect(outdated.onAir()).toEqual({ kind: 'unconfirmed', reason: '界面重新加载过，联动台播放还在按重新加载前的工程播这首歌，和这里打开的不是同一版' });
    expect(adopted.onAir()).toMatchObject({ kind: 'version' });
  });
});

describe('接回的节目是另一版时，停下以后按界面里的工程重新打开', () => {
  const statuses: ProgramPlayerState['status'][] = ['preparing', 'playing', 'paused', 'stopped', 'error'];

  it('接回的是另一版：还拿着歌时不重开，停止或出错以后重开', () => {
    expect(statuses.map(status => reopensShown(true, status))).toEqual([false, false, false, true, true]);
  });

  it('同一版，或者还没答复：都不重开', () => {
    for (const outdated of [false, null]) expect(statuses.map(status => reopensShown(outdated, status))).toEqual([false, false, false, false, false]);
  });
});

describe('播放器打开时用设备设置里的声卡', () => {
  const configured = { deviceId: '声卡 2', sampleRate: 48000 };

  it('设置和界面开始时的不一样：没拿着歌就换成设置里的（重新加载后第一次打开就用它，不先用默认声卡开一次再重开）', () => {
    expect(followAudioConfiguration({ deviceId: 'default', sampleRate: 48000 }, configured, false)).toEqual(configured);
    expect(followAudioConfiguration({ deviceId: '声卡 2', sampleRate: 44100 }, configured, false)).toEqual(configured);
  });

  it('拿着歌时不换，停下以后再换；没变化时返回原来那份，界面不会因此重开播放器', () => {
    const current = { deviceId: 'default', sampleRate: 48000 };
    expect(followAudioConfiguration(current, configured, true)).toBe(current);
    const same = { deviceId: '声卡 2', sampleRate: 48000 };
    expect(followAudioConfiguration(same, configured, false)).toBe(same);
  });
});
