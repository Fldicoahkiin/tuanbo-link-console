import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, linkShowStateSchema, type LinkShowState, type NativeProgramOpen } from '@tb/schema';
import { emptyInternalPlayerState, type PlaybackBoundary } from '@tb/core/link';
import { NativeProgramService } from './native-program-service';
import { closedProgramFaultReporter } from './main-process-errors';
import { ShowStateService } from './show-state-service';

function request(): NativeProgramOpen {
  return { version: 1, ownerId: randomUUID(), projectPath: 'C:/test/show.tblink', revision: 1, sessionId: randomUUID(),
    document: JSON.stringify({ ...createEmptyLinkProject('演出状态测试'), playbackSource: 'internal' }),
    configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } };
}
function host() {
  const clock = { read: () => ({ positionMs: 0, durationMs: 60_000, ready: true, playing: false, seeking: false }),
    subscribeBoundary: vi.fn<(listener: (boundary: PlaybackBoundary) => void) => () => void>(() => () => undefined) };
  return { close: vi.fn(() => Promise.resolve()), controller: { clock,
    play: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), reset: vi.fn(() => Promise.resolve()), toggle: vi.fn(() => Promise.resolve()),
    seek: vi.fn(() => Promise.resolve()), scrub: vi.fn(() => Promise.resolve()), skip: vi.fn(() => Promise.resolve()),
    previewVolume: vi.fn(), overrideVolume: vi.fn(), setEndAction: vi.fn(), setPlaylist: vi.fn(), toggleMtc: vi.fn(), receiveMidi: vi.fn(), fade: vi.fn(),
    preloadSelected: vi.fn(), obsReconnected: vi.fn(), freeze: vi.fn(), reportUnavailable: vi.fn(), runtimeUnavailable: vi.fn(), reportFault: vi.fn(), clearFault: vi.fn(), externalStop: vi.fn(),
    setWatched: vi.fn(), updateProject: vi.fn(), currentProject: vi.fn(), getAudioAnalysis: () => null, dispose: vi.fn(() => Promise.resolve()) } };
}
/** The real program service, with its player state in the test's hands, and the show state built on it as link-main does. */
async function opened() {
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => host());
  const program = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), () => undefined, closedProgramFaultReporter(() => Promise.resolve(), vi.fn()));
  const published: LinkShowState[] = [];
  const show = new ShowStateService(program, value => published.push(linkShowStateSchema.parse(value)));
  const input = request();
  await program.open(input);
  const player = create.mock.calls[0]![2];
  return { program, show, published, input, player };
}
const playing = { ...emptyInternalPlayerState, itemId: 'song', status: 'playing' as const, positionMs: 5_000, durationMs: 60_000 };

it('没有节目、也没有界面上报时是空闲', () => {
  const program = new NativeProgramService(vi.fn(), vi.fn(), () => Promise.resolve(), () => undefined, closedProgramFaultReporter(() => Promise.resolve(), vi.fn()));
  expect(new ShowStateService(program, vi.fn()).current()).toEqual({ phase: 'idle', program: null });
});

it('节目暂停：held（暂停），控台同步可以做；播放时节目在走，要等', async () => {
  const { show, published, input, player } = await opened();
  player.changed(playing);
  expect(show.current()).toMatchObject({ phase: 'running', source: 'internal', itemId: 'song' });
  expect(show.gate('ma2.sync.write')).toMatchObject({ kind: 'wait', until: 'clock-stopped' });
  player.changed({ ...playing, status: 'paused' });
  expect(show.current()).toEqual({ phase: 'held', source: 'internal', itemId: 'song', reason: 'paused',
    program: { projectPath: input.projectPath, projectId: (JSON.parse(input.document) as { projectId: string }).projectId, watched: true } });
  expect(show.gate('ma2.sync.write')).toEqual({ kind: 'allow' });
  expect(published.at(-1)).toMatchObject({ phase: 'held', reason: 'paused' });
});

it('只在演出状态变了时才发：播放位置每次都变，状态不变就不发', async () => {
  const { published, player } = await opened();
  player.changed(playing);
  const count = published.length;
  player.changed({ ...playing, positionMs: 6_000 }); player.changed({ ...playing, positionMs: 7_000 });
  expect(published).toHaveLength(count);
});

it('页面没了：界面报的 P1 跟随和预览一起清掉', async () => {
  const { program, show } = await opened();
  await program.close();
  show.report({ version: 1, p1: { state: 'running', itemId: 'p1-song' }, preview: false });
  expect(show.current()).toMatchObject({ phase: 'running', source: 'p1', itemId: 'p1-song' });
  show.report({ version: 1, p1: null, preview: true });
  expect(show.current()).toMatchObject({ phase: 'running', source: 'preview' });
  show.pageGone();
  expect(show.current()).toEqual({ phase: 'idle', program: null });
});

it('孤儿节目还在后台放：不是空闲，并说明没有界面在看', async () => {
  const { program, show, published, input, player } = await opened();
  player.changed(playing);
  show.report({ version: 1, p1: null, preview: true });
  expect(await program.release()).toMatchObject({ status: 'playing' });
  show.pageGone();
  expect(show.current()).toMatchObject({ phase: 'running', source: 'internal', itemId: 'song', program: { watched: false } });
  expect(published.at(-1)).toMatchObject({ phase: 'running', program: { watched: false } });
  // The page took the program back: watched again.
  expect(await program.open({ ...input, ownerId: randomUUID() })).toBe('adopted');
  expect(show.current()).toMatchObject({ phase: 'running', program: { watched: true } });
});

it('界面上报的内容在边界上校验，不合格的不改状态', async () => {
  const { show } = await opened();
  expect(() => show.report({ version: 1, p1: { state: 'playing', itemId: null }, preview: false })).toThrow();
  expect(() => show.report({ p1: null, preview: false })).toThrow();
  expect(show.current()).toMatchObject({ phase: 'idle' });
});

// R13：关灯清单接进演出状态。停下的节目在关灯指令发往控台、还没回应时算“节目在停止”；回应以后回到空闲。
it('停下的节目还有关灯指令在发时算在停止，发完回到空闲', async () => {
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => host());
  const program = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), () => undefined, closedProgramFaultReporter(() => Promise.resolve(), vi.fn()));
  let sending = false, changed: () => void = () => undefined;
  const show = new ShowStateService(program, vi.fn(), { sending: () => sending, onChanged: listener => { changed = listener; return () => undefined; } });
  await program.open(request());
  const player = create.mock.calls[0]![2];
  player.changed({ ...playing, status: 'stopped' });
  expect(show.current()).toMatchObject({ phase: 'idle' });
  sending = true; changed();
  expect(show.current()).toMatchObject({ phase: 'stopping', source: 'internal' });
  sending = false; changed();
  expect(show.current()).toMatchObject({ phase: 'idle' });
});
