import { describe, expect, it, vi } from 'vitest';
import { emptyInternalPlayerState, type LinkDesktopApi } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type NativeProgramAttachment, type NativeProgramDocumentVersion, type ProgramPlayerState } from '@tb/schema';
import { programPlays } from './program-attachment';
import { RemoteNativeProgramPlayer } from './runtime/remote-native-program-player';
import { programVersionKey } from './runtime/program-document-feed';
import { pictureOnAir } from './view-models/picture-on-air';

const project = parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', rundown: [{ id: 'song', title: '第三首' }] });

describe('后台节目答复打开以后，界面才知道它在播哪一版', () => {
  it('没有控制器、还没答复、还没听到版本：都不知道（null），不当成同一版', () => {
    const unknown = { outdated: null, project: null, pictureProject: null };
    expect(programPlays(null, 'a:1', 1)).toEqual(unknown);
    expect(programPlays({ attached: false, project, pictureProject: project }, 'a:1', 1)).toEqual(unknown);
    expect(programPlays({ attached: true, project, pictureProject: project }, null, 1)).toEqual(unknown);
  });

  it('画面跟的是这一页送过的版本：就是那一版的工程；不是这一页送的：另一版', () => {
    expect(programPlays({ attached: true, project, pictureProject: project }, 'a:1', 1)).toEqual({ outdated: false, project, pictureProject: project });
    expect(programPlays({ attached: true, project: null, pictureProject: null }, 'a:1', 1)).toEqual({ outdated: true, project: null, pictureProject: null });
  });

  it('拿着歌时最新一版已经是这一页的，画面还跟开始那一版（0.5.9 S8a）：按画面那一版判断', () => {
    const newer = { ...project, name: '新的一版' };
    expect(programPlays({ attached: true, project: newer, pictureProject: project }, 'a:2 a:1', 1)).toEqual({ outdated: false, project: newer, pictureProject: project });
    expect(programPlays({ attached: true, project: newer, pictureProject: null }, 'a:2 b:9', 1)).toEqual({ outdated: true, project: newer, pictureProject: null });
  });
});

describe('评审场景：界面重新加载后接回还在播的节目，后台先发状态、后答复打开', () => {
  const session = crypto.randomUUID();

  /** The real controller, wired as useInternalPlayer wires it; the program has not answered the open yet. */
  async function reopenedWindow() {
    let answerOpen!: (attachment: NativeProgramAttachment) => void;
    const api = {
      openNativeProgram: vi.fn<LinkDesktopApi['openNativeProgram']>(() => new Promise(resolve => { answerOpen = resolve; })),
      controlNativeProgram: vi.fn<LinkDesktopApi['controlNativeProgram']>(() => Promise.resolve()),
      documentNativeProgram: vi.fn<LinkDesktopApi['documentNativeProgram']>(request => Promise.resolve({ kind: 'applied', revision: request.revision, effect: 'stopped' })),
      onNativeProgramEvent: vi.fn<LinkDesktopApi['onNativeProgramEvent']>(() => vi.fn()),
      onNativeProgramClosed: vi.fn<LinkDesktopApi['onNativeProgramClosed']>(() => vi.fn()),
      onNativePlaybackStatus: vi.fn<LinkDesktopApi['onNativePlaybackStatus']>(() => vi.fn())
    };
    let state: Pick<ProgramPlayerState, 'status' | 'itemId'> = emptyInternalPlayerState, version: string | null = null, attachments = 0;
    const controller = new RemoteNativeProgramPlayer({
      configuration: () => ({ outputDeviceId: 'default', mtcPortName: null }), changed: next => { state = next; }, notice: vi.fn(),
      document: () => ({ project, path: 'C:/show/现场.tblink', sessionId: session, revision: 3 }), attached: () => { attachments += 1; },
      encode: value => Promise.resolve(JSON.stringify(value)) },
    api, event => { version = programVersionKey(event.documentVersion); }, crypto.randomUUID());
    // The open goes once the project is encoded (0.5.9 S9).
    await new Promise(resolve => setTimeout(resolve, 0));
    const ownerId = api.openNativeProgram.mock.calls[0]![0].ownerId;
    return {
      /** The program kept playing over the reload: it sends its state first, naming the version it plays. */
      playing: (documentVersion: NativeProgramDocumentVersion) => api.onNativeProgramEvent.mock.calls[0]![0]({ version: 1, ownerId, sequence: 1,
        state: { ...emptyInternalPlayerState, status: 'playing', itemId: 'song', positionMs: 12_500 },
        clock: { positionMs: 12_500, durationMs: 20_000, ready: true, playing: true, seeking: false }, currentCueId: null, documentVersion, pictureVersion: documentVersion }),
      answer: async (attachment: NativeProgramAttachment) => { answerOpen(attachment); await new Promise(resolve => setTimeout(resolve, 0)); },
      onAir: () => {
        const plays = programPlays(controller, version, attachments);
        return pictureOnAir('song', true, { state, project: plays.pictureProject, outdated: plays.outdated });
      }
    };
  }

  it('答复前写正在确认；播的是重新加载前那一页的版本写界面重新加载过；是这一页的版本才按这版标', async () => {
    const outdated = await reopenedWindow(), adopted = await reopenedWindow();
    outdated.playing({ sessionId: crypto.randomUUID(), revision: 9 });
    adopted.playing({ sessionId: session, revision: 3 });
    for (const window of [outdated, adopted]) expect(window.onAir()).toEqual({ kind: 'unconfirmed', reason: '正在确认联动台播放在播哪一版', waiting: true });
    await outdated.answer('outdated'); await adopted.answer('adopted');
    expect(outdated.onAir()).toEqual({ kind: 'unconfirmed', reason: '界面重新加载过，联动台播放还在按重新加载前的工程播这首歌，和这里打开的不是同一版' });
    expect(adopted.onAir()).toMatchObject({ kind: 'version' });
  });
});
