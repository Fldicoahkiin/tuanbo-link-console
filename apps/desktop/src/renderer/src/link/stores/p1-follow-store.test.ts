import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type P1FollowRequest, type P1FollowState } from '@tb/schema';

const bridge = vi.hoisted(() => ({
  p1Follow: vi.fn<(request: P1FollowRequest) => Promise<P1FollowState>>(),
  getP1FollowState: vi.fn<() => Promise<P1FollowState>>(),
  onP1FollowState: vi.fn(() => () => undefined),
  recordLog: vi.fn(() => Promise.resolve())
}));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: bridge }));
vi.mock('./project-codec', async original => ({ ...await original<Record<string, unknown>>(), projectCodec: { encode: vi.fn(() => Promise.resolve('{}')) } }));

const { P1_FOLLOW_PAGE } = await import('../runtime/p1-follow-client');
const { chooseP1Song, followP1, setMainErrorsShown, showP1Follow, useP1FollowStore } = await import('./p1-follow-store');
const { useDocumentStore } = await import('./document-store');
const { useIntegrationStore } = await import('./integration-store');
const { useRuntimeStore } = await import('./runtime-store');
const { createDefaultIntegrationProfile } = await import('../view-models/local-integration-profile');

const OTHER = '7f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const state = (patch: Partial<P1FollowState>): P1FollowState => ({ version: 1, phase: 'standby', ownerId: P1_FOLLOW_PAGE, projectId: 'p', projectPath: 'C:/show.tblink',
  projectName: '演出', mode: 'manual', runMode: 'live', itemId: null, sessionId: null, generation: 0, positionMs: null, cause: null, reason: null,
  input: { portName: 'loopMIDI Port', state: 'open', reason: null }, mtc: null, outputs: { actionMidi: null }, ...patch } as P1FollowState);

function open(auto: boolean): void {
  useDocumentStore.getState().setProject(parseLinkProject({ ...createEmptyLinkProject('演出'), playbackSource: 'p1', p1AutoFollow: { enabled: auto, ranges: [{ itemId: 'song', startSeconds: 60, durationMs: 60_000 }] },
    rundown: [{ id: 'song', title: '歌', cues: [] }, { id: 'next', title: '下一首', cues: [] }] }), 'C:/show.tblink');
}

beforeEach(() => {
  bridge.p1Follow.mockReset();
  useRuntimeStore.getState().reset();
  const profile = createDefaultIntegrationProfile();
  useIntegrationStore.getState().setProfile({ ...profile, midiPortProfiles: profile.midiPortProfiles.map(port => port.id === profile.p1.mtcInputPortProfileId ? { ...port, portName: 'loopMIDI Port' } : port) });
  setMainErrorsShown(true);
});

describe('界面里的跟随 P1 状态（P4）', () => {
  it('自动选歌：开始以后接着听 P1 点歌；跟着一首歌时不重新开始', async () => {
    open(true);
    bridge.p1Follow.mockImplementation(request => Promise.resolve(state({ mode: 'auto', phase: request.command.kind === 'arm' ? 'waiting' : 'standby' })));
    await followP1();
    expect(bridge.p1Follow.mock.calls.map(([request]) => request.command.kind)).toEqual(['start', 'arm']);
    expect(bridge.p1Follow.mock.calls[1]?.[0].command).toEqual({ kind: 'arm', itemId: null });
    showP1Follow(state({ mode: 'auto', phase: 'running', itemId: 'song' }));
    // A newer version waits until no song is followed (the main process would refuse it).
    useDocumentStore.setState({ revision: useDocumentStore.getState().revision + 1 });
    await followP1();
    expect(bridge.p1Follow).toHaveBeenCalledTimes(2);
  });

  it('运行状态只照这个页面的跟随写；别的页面的跟随不写', () => {
    open(false);
    showP1Follow(state({ phase: 'running', itemId: 'song', mtc: { timecode: { hours: 1, minutes: 0, seconds: 2, frames: 3 }, frameRate: '30', receiving: true, stable: true } }));
    expect(useRuntimeStore.getState()).toMatchObject({ state: 'running', currentItemId: 'song', timecode: { hours: 1, minutes: 0, seconds: 2, frames: 3 }, mtcStable: true });
    expect(useRuntimeStore.getState().lastMtcAt).not.toBeNull();
    showP1Follow(state({ ownerId: OTHER, phase: 'frozen', cause: 'lost', itemId: 'next' }));
    expect(useRuntimeStore.getState()).toMatchObject({ state: 'running', currentItemId: 'song' });
    expect(useP1FollowStore.getState().follow?.ownerId).toBe(OTHER);
  });

  it('选歌只在没跟随时改；跟着的歌由 P1 定', () => {
    open(false);
    showP1Follow(state({ phase: 'standby' }));
    chooseP1Song('next');
    expect(useRuntimeStore.getState().currentItemId).toBe('next');
    showP1Follow(state({ phase: 'running', itemId: 'song' }));
    chooseP1Song('next');
    expect(useRuntimeStore.getState().currentItemId).toBe('song');
  });
});
