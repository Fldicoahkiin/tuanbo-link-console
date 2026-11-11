import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { emptyInternalPlayerState } from '@tb/core/link';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type NativeProgramDocument, type NativeProgramDocumentAnswer } from '@tb/schema';
import { ProgramDocumentFeed, type ProgramDocument } from './program-document-feed';
import { NativeProgramService } from '../../../../main/link/native-program-service';
import { closedProgramFaultReporter } from '../../../../main/link/main-process-errors';

// 0.5.9 S9（design 02 §3.3、§3.7）：界面只送改过的部分，拼在它送过的上一版上；节目只拼在它手里的那一版上，
// 对不上就要整份。这里界面和主进程都是真的，中间像 IPC 一样按顺序、异步地传。
const PATH = 'C:/show/现场.tblink';
const SHA = 'a'.repeat(64);
function song(id: string, relativePath = `assets/reference-audio/${id}.wav`) {
  return { id, title: id, referenceAudio: { assetId: `audio-${id}`, relativePath, sha256: SHA, durationMs: 60000 } };
}
const show = (): LinkProject => parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal', rundown: [song('a'), song('b')] });
const whole = (project: LinkProject): LinkProject => parseLinkProject(JSON.parse(JSON.stringify(project)));
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function connected(options: { encode?: (project: LinkProject) => Promise<string>; refuse?: (request: NativeProgramDocument) => Error | null } = {}) {
  const clock = { read: () => ({ positionMs: 0, durationMs: 1000, ready: true, playing: false, seeking: false }),
    subscribeBoundary: (): (() => void) => () => undefined };
  const updateProject = vi.fn<(project: LinkProject, revision: number) => void>();
  const controller = { clock, updateProject, setWatched: vi.fn() } as unknown as ReturnType<ConstructorParameters<typeof NativeProgramService>[0]>['controller'];
  let playerChanged: ((state: typeof emptyInternalPlayerState) => void) | null = null;
  const service = new NativeProgramService((_project, _request, callbacks) => { playerChanged = state => callbacks.changed(state); return { controller, close: () => Promise.resolve() }; }, () => undefined, () => Promise.resolve(), () => undefined,
    closedProgramFaultReporter(() => Promise.resolve(), () => undefined));
  const ownerId = randomUUID(), sessionId = randomUUID();
  let current: ProgramDocument = { project: show(), path: PATH, sessionId, revision: 1 };
  await service.open({ version: 1, ownerId, projectPath: PATH, revision: 1, sessionId, document: JSON.stringify(current.project),
    configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } });
  /** Files a version references, as the program checks them: a path with “外面” lies outside the project. */
  const checkFiles = (_path: string, files: string[]): Promise<void> => {
    const outside = files.find(file => file.includes('外面'));
    return outside ? Promise.reject(new Error(`工程素材 ${outside} 指向工程文件夹之外，已拒绝`)) : Promise.resolve();
  };
  /** The bridge, in order and later, as IPC; `hold` keeps an answer back until released. */
  const held: (() => void)[] = [];
  let holding = false;
  const send = vi.fn((request: NativeProgramDocument): Promise<NativeProgramDocumentAnswer> => {
    const copy = structuredClone(request);
    const refused = options.refuse?.(copy) ?? null;
    const answer = refused ? Promise.reject(refused) : Promise.resolve().then(() => service.document(copy, checkFiles));
    if (!holding) return answer;
    // The program takes it now, in order; only its answer waits.
    const outcome = answer.then(value => ({ value }), (error: unknown) => ({ error }));
    return new Promise((resolve, reject) => { held.push(() => { void outcome.then(result => 'value' in result ? resolve(result.value) : reject(result.error as Error)); }); });
  });
  const encode = vi.fn(options.encode ?? ((project: LinkProject) => Promise.resolve(JSON.stringify(project))));
  const failed = vi.fn<(message: string) => void>();
  const feed = new ProgramDocumentFeed(ownerId, () => current, send, failed, encode);
  feed.attached(current);
  return {
    service, feed, send, encode, failed, updateProject,
    edit: (change: (project: LinkProject) => LinkProject) => { current = { ...current, project: change(current.project), revision: current.revision + 1 }; },
    current: () => current,
    /** The program plays a song: newer versions wait for 停止. */
    hold: () => playerChanged?.({ ...emptyInternalPlayerState, status: 'playing', itemId: 'a' }),
    /** The project the program plays now. */
    playing: () => updateProject.mock.lastCall?.[0],
    holdAnswers: () => { holding = true; },
    answer: () => { holding = false; for (const release of held.splice(0)) release(); },
    sent: () => send.mock.calls.map(([request]) => ({ revision: request.revision, base: request.base, kind: request.change.kind }))
  };
}
const rename = (index: number, title: string) => (project: LinkProject): LinkProject =>
  ({ ...project, rundown: project.rundown.map((item, at) => at === index ? { ...item, title } : item) });
const outside = (project: LinkProject): LinkProject => ({ ...project, rundown: project.rundown.map((item, at) => at === 1
  ? { ...item, referenceAudio: { ...item.referenceAudio!, relativePath: 'assets/reference-audio/外面.wav' } } : item) });

describe('一版在路上时又开歌（flush）', () => {
  it('先答复上一版、再 flush：新的一版拼在答复过的那一版上', async () => {
    const f = await connected();
    f.edit(rename(0, '第二版')); f.feed.changed(); await settle();
    f.edit(rename(1, '第三版')); await f.feed.flush(); await settle();
    expect(f.sent()).toEqual([{ revision: 2, base: 1, kind: 'items' }, { revision: 3, base: 2, kind: 'items' }]);
    expect(f.playing()).toEqual(whole(f.current().project));
    expect(f.encode).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });

  it('上一版还没答复就 flush：新的一版拼在路上那一版上；节目按顺序先收上一版，所以拼得上', async () => {
    const f = await connected();
    f.holdAnswers();
    f.edit(rename(0, '第二版')); f.feed.changed(); await settle();
    f.edit(rename(1, '第三版')); await f.feed.flush();
    f.answer(); await settle();
    expect(f.sent()).toEqual([{ revision: 2, base: 1, kind: 'items' }, { revision: 3, base: 2, kind: 'items' }]);
    expect(f.updateProject.mock.calls.map(([, revision]) => revision)).toEqual([2, 3]);
    expect(f.playing()).toEqual(whole(f.current().project));
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('路上那一版节目没收（引用了工程外的文件）：拼在它上面的那一版答复 resync，整份送一次，节目拿到的是最新的整份，不会拼在错的版本上', async () => {
    const f = await connected();
    f.holdAnswers();
    f.edit(outside); f.feed.changed(); await settle();
    f.edit(project => ({ ...rename(0, '第三版')(project), rundown: [rename(0, '第三版')(project).rundown[0]!, show().rundown[1]!] })); await f.feed.flush();
    f.answer(); await settle(); await settle();
    expect(f.sent()).toEqual([{ revision: 2, base: 1, kind: 'items' }, { revision: 3, base: 2, kind: 'items' }, { revision: 3, base: null, kind: 'full' }]);
    expect(f.updateProject.mock.calls.map(([, revision]) => revision)).toEqual([3]);
    expect(f.playing()).toEqual(whole(f.current().project));
    // The refusal of the version on its way was decided by the newer one: nothing is said in red.
    expect(f.failed).not.toHaveBeenCalled();
  });

  it('整份也不收：标红一次，不再自己送；下一次修改照常送', async () => {
    const f = await connected();
    f.holdAnswers();
    f.edit(outside); f.feed.changed(); await settle();
    f.edit(rename(0, '第三版')); await f.feed.flush();
    f.answer(); await settle(); await settle(); await settle();
    expect(f.sent()).toEqual([{ revision: 2, base: 1, kind: 'items' }, { revision: 3, base: 2, kind: 'items' }, { revision: 3, base: null, kind: 'full' }]);
    expect(f.failed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('这次修改没送进节目：工程素材 assets/reference-audio/外面.wav'));
    expect(f.updateProject).not.toHaveBeenCalled();
    await settle(); expect(f.send).toHaveBeenCalledTimes(3);
  });
});

describe('整份发送', () => {
  it('base 对不上（节目手里是别的版本）：resync 后整份送一次；整份也被要求重送就标红一次，不再自己送', async () => {
    const answers: NativeProgramDocumentAnswer[] = [{ kind: 'resync', reason: '节目这边没有这次修改所基于的版本' }, { kind: 'resync', reason: '还是对不上' }];
    const send = vi.fn((request: NativeProgramDocument): Promise<NativeProgramDocumentAnswer> =>
      Promise.resolve(answers.shift() ?? { kind: 'applied', revision: request.revision, effect: 'stopped' }));
    const failed = vi.fn<(message: string) => void>(), project = show(), sessionId = randomUUID();
    let current: ProgramDocument = { project, path: PATH, sessionId, revision: 1 };
    const feed = new ProgramDocumentFeed(randomUUID(), () => current, send, failed, value => Promise.resolve(JSON.stringify(value)));
    feed.attached(current);
    current = { ...current, project: rename(0, '改')(project), revision: 2 }; feed.changed();
    await settle(); await settle();
    expect(send.mock.calls.map(([request]) => [request.base, request.change.kind])).toEqual([[1, 'items'], [null, 'full']]);
    expect(failed).toHaveBeenCalledExactlyOnceWith('这次修改没送进节目：还是对不上');
    // Only the next song start sends it again, whole.
    await feed.flush(); expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall?.[0]).toMatchObject({ revision: 2, base: null, change: { kind: 'full' } });
  });

  it('整份在编码的 worker 里做，不在这条线程上；编好以前开歌的 flush 等它，后面那一版排在它后面', async () => {
    let finish!: () => void;
    const encoding = new Promise<void>(resolve => { finish = resolve; });
    const f: Awaited<ReturnType<typeof connected>> = await connected({ encode: project => encoding.then(() => JSON.stringify(project)), refuse: () => f.send.mock.calls.length === 1 ? new Error('IPC 断了') : null });
    f.edit(rename(0, '第二版')); f.feed.changed(); await settle();
    expect(f.failed).toHaveBeenCalledOnce();
    // The send failed: only the next song start sends it again, whole.
    let flushed = false;
    const flush = f.feed.flush().then(() => { flushed = true; });
    f.edit(rename(1, '第四版')); const next = f.feed.flush();
    await settle();
    expect(f.encode).toHaveBeenCalledOnce(); expect(flushed).toBe(false); expect(f.send).toHaveBeenCalledOnce();
    finish(); await flush; await next; await settle();
    expect(f.sent()).toEqual([{ revision: 2, base: 1, kind: 'items' }, { revision: 2, base: null, kind: 'full' }, { revision: 3, base: 2, kind: 'items' }]);
    expect(f.playing()).toEqual(whole(f.current().project));
  });

  it('换了会话（重新读了文件）就整份送', async () => {
    const f = await connected();
    f.edit(rename(0, '第二版'));
    const read = f.current();
    // A file read again is a new session of the same project and path.
    const feed = new ProgramDocumentFeed(randomUUID(), () => ({ ...read, sessionId: randomUUID() }), f.send, f.failed, f.encode);
    feed.attached({ ...read, revision: 1 }); await settle(); await settle();
    expect(f.encode).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({ base: null, change: { kind: 'full' } });
  });
});

describe('拿着歌时', () => {
  it('增量照旧等停止（next-pass），节目手里等着的那一版就是下一次的基准', async () => {
    const f = await connected();
    f.hold();
    f.edit(rename(0, '第二版')); f.feed.changed(); await settle();
    f.edit(rename(1, '第三版')); f.feed.changed(); await settle();
    expect(f.sent()).toEqual([{ revision: 2, base: 1, kind: 'items' }, { revision: 3, base: 2, kind: 'items' }]);
    expect(f.updateProject).not.toHaveBeenCalled(); expect(f.failed).not.toHaveBeenCalled();
  });
});
