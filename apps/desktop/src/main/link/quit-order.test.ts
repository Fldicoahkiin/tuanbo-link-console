import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEmptyLinkProject, type NativeProgramOpen, type NativeProgramOperation } from '@tb/schema';
import { toUserErrorMessage, type PlaybackBoundary } from '@tb/core/link';
import { NativeProgramService } from './native-program-service';
import { closedProgramFaultReporter } from './main-process-errors';
import { quitInOrder, type QuitSteps } from './quit-order';
import type { ExternalApplicationId } from './external-process-manager';

function request(): NativeProgramOpen { return { version: 1, ownerId: randomUUID(), projectPath: 'C:/test/show.tblink', revision: 1, sessionId: randomUUID(),
  document: JSON.stringify({ ...createEmptyLinkProject('退出顺序'), playbackSource: 'internal' }),
  configuration: { outputDeviceId: 'default', mtcPortName: null, preciseSeeking: false } }; }
function host(order: string[]) {
  const clock = { read: () => ({ positionMs: 0, durationMs: 1000, ready: true, playing: false, seeking: false }),
    subscribeBoundary: vi.fn<(listener: (boundary: PlaybackBoundary) => void) => () => void>(() => () => undefined) };
  return { close: vi.fn(() => { order.push('关节目'); return Promise.resolve(); }), controller: { clock, sessionId: 'session',
    play: vi.fn(() => Promise.resolve()), pause: vi.fn(() => Promise.resolve()), resume: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()), reset: vi.fn(() => Promise.resolve()), toggle: vi.fn(() => Promise.resolve()),
    seek: vi.fn(() => Promise.resolve()), scrub: vi.fn(() => Promise.resolve()), skip: vi.fn(() => Promise.resolve()),
    previewVolume: vi.fn(), overrideVolume: vi.fn(), setEndAction: vi.fn(), setPlaylist: vi.fn(), toggleMtc: vi.fn(), receiveMidi: vi.fn(), fade: vi.fn(),
    preloadSelected: vi.fn(), obsReconnected: vi.fn(), freeze: vi.fn(), reportUnavailable: vi.fn(), runtimeUnavailable: vi.fn(), reportFault: vi.fn(), clearFault: vi.fn(), externalStop: vi.fn(),
    setWatched: vi.fn(), updateProject: vi.fn(), currentProject: vi.fn(), actionsProject: vi.fn(), getAudioAnalysis: () => null, dispose: vi.fn(() => Promise.resolve()) } };
}
const command = (input: NativeProgramOpen, operation: NativeProgramOperation) => ({ version: 1, ownerId: input.ownerId, operation });
const play = (service: NativeProgramService, input: NativeProgramOpen) => service.control(command(input, { kind: 'play', itemId: 'song' }))
  .then(() => '播了', (error: unknown) => `没播：${toUserErrorMessage(error)}`);
const midiLeftOpen = '关闭节目时动作 MIDI 没有正常关掉，之后的歌照常播放。原因：MIDI 驱动服务异常退出：3。如果之后的歌没有发出动作 MIDI，请检查 MIDI 接口和线。';
const lightsLeftOn = '「开场」的灯光没能完全关闭，控台上可能还亮着。原因：控台没有连接。请在控台上关掉这首歌的执行器。';

/** link-main's runQuitFlow over the real program service: what each step does is written into `order`; the dialogs
 * answer as `answers` says. */
async function quit(answers: { audition?: boolean; external?: readonly ExternalApplicationId[] | null; started?: boolean;
  lightsOff?: boolean; midiClosed?: boolean; quitWithLightsOn?: boolean; outputs?: () => Promise<void> } = {}) {
  const order: string[] = [], hosts: ReturnType<typeof host>[] = [];
  const create = vi.fn<ConstructorParameters<typeof NativeProgramService>[0]>(() => { const made = host(order); hosts.push(made); return made; });
  const faults = closedProgramFaultReporter(() => Promise.resolve(), vi.fn());
  const service = new NativeProgramService(create, vi.fn(), () => Promise.resolve(), () => undefined, faults);
  const window = request();
  await service.open(window);
  if (answers.midiClosed === false) {
    hosts[0]!.close.mockImplementationOnce(() => { order.push('关节目'); create.mock.calls[0]![2].closedFault(midiLeftOpen, 'song', 'leftOpen'); return Promise.resolve(); });
  }
  if (answers.lightsOff === false) {
    hosts[0]!.close.mockImplementationOnce(() => { order.push('关节目'); create.mock.calls[0]![2].closedFault(lightsLeftOn, 'song'); return Promise.resolve(); });
  }
  const steps = {
    stopAudition: vi.fn(() => { order.push('停灯光试听'); return Promise.resolve(answers.audition ?? true); }),
    askExternalPrograms: vi.fn(() => { order.push('问外部程序'); return Promise.resolve(answers.external === undefined ? ['obs'] as const : answers.external); }),
    songStarted: vi.fn(() => { order.push('看有没有在播'); return answers.started ?? false; }),
    program: service, faults,
    quitWithLightsOn: vi.fn((messages: readonly string[]) => { order.push(`问灯光：${messages.join('')}`); return Promise.resolve(answers.quitWithLightsOn ?? false); }),
    programClosed: vi.fn<QuitSteps['programClosed']>(() => { order.push('告诉窗口节目关了'); }),
    closeOutputs: vi.fn(() => { order.push('关音频和画面'); return answers.outputs?.() ?? Promise.resolve(); }),
    finish: vi.fn((close: readonly string[]) => { order.push(`关外部程序：${close.join('、')}，结束`); return Promise.resolve(); }),
    record: vi.fn()
  } satisfies QuitSteps;
  const result = await quitInOrder(steps).then(quitted => quitted ? '退出了' : '回到软件', (error: unknown) => `退出失败：${toUserErrorMessage(error)}`);
  return { result, order, steps, service, window, create };
}

// 修复前：退出时先关掉窗口的节目，再问外部程序；操作员在“逐项确认外部程序”里选默认的“取消退出”回到软件，按下一首的播放
// 只得到“这个播放控制请求来自已关闭的界面”，歌不开始，要重新打开工程才能播。
it('外部程序逐项确认时选“取消退出”：节目还没关，回到软件后照常能播', async () => {
  const q = await quit({ external: null });
  expect(q.result).toBe('回到软件');
  expect(q.order).toEqual(['停灯光试听', '问外部程序']);
  expect(await play(q.service, q.window)).toBe('播了');
  expect(q.steps.programClosed).not.toHaveBeenCalled();
});

it('灯光试听停不掉、选“返回软件”：什么都还没问、没关', async () => {
  const q = await quit({ audition: false });
  expect(q.result).toBe('回到软件');
  expect(q.order).toEqual(['停灯光试听']);
  expect(await play(q.service, q.window)).toBe('播了');
});

// 修复前：节目欠的关灯在关节目时没发出去，退出时弹“返回软件 / 仍然退出”，按默认的“返回软件”以后窗口的节目已经关了，
// 窗口不知道，按播放同样被拒绝。
it('能问的都在关节目之前问完；关节目时灯光没关掉、选“返回软件”：告诉这个窗口它的节目关了，让它重新打开；音频引擎和外部程序都不关', async () => {
  const q = await quit({ lightsOff: false, quitWithLightsOn: false });
  expect(q.result).toBe('回到软件');
  expect(q.order).toEqual(['停灯光试听', '问外部程序', '看有没有在播', '关节目', `问灯光：${lightsLeftOn}`, '告诉窗口节目关了']);
  expect(q.steps.programClosed).toHaveBeenCalledExactlyOnceWith({ version: 1, ownerId: q.window.ownerId });
  // The window opens a new program, as after a project change, and that one plays.
  const reopened = request();
  expect(await q.service.open(reopened)).toBe('opened');
  expect(await play(q.service, reopened)).toBe('播了');
  expect(q.create).toHaveBeenCalledTimes(2);
});

it('关节目时灯光没关掉、选“仍然退出”：再关音频和画面、关选中的外部程序，然后结束；不再告诉窗口', async () => {
  const q = await quit({ lightsOff: false, quitWithLightsOn: true });
  expect(q.result).toBe('退出了');
  expect(q.order).toEqual(['停灯光试听', '问外部程序', '看有没有在播', '关节目', `问灯光：${lightsLeftOn}`, '关音频和画面', '关外部程序：obs，结束']);
  expect(q.steps.programClosed).not.toHaveBeenCalled();
});

it('灯光都关了：不问灯光，关节目、音频和画面、外部程序，然后结束', async () => {
  const q = await quit({ external: [] });
  expect(q.result).toBe('退出了');
  expect(q.order).toEqual(['停灯光试听', '问外部程序', '看有没有在播', '关节目', '关音频和画面', '关外部程序：，结束']);
  expect(q.steps.programClosed).not.toHaveBeenCalled();
});

// 问外部程序（还有之前的未保存修改、灯光试听）的时候，窗口里的播放控制 MIDI 照样能开始一首歌：这时不能把它关掉。
it('问的时候开始播放了：不关节目，和播放中按退出一样回到软件', async () => {
  const q = await quit({ started: true });
  expect(q.result).toBe('回到软件');
  expect(q.order).toEqual(['停灯光试听', '问外部程序', '看有没有在播']);
  expect(await play(q.service, q.window)).toBe('播了');
  expect(q.steps.programClosed).not.toHaveBeenCalled();
});

it('节目关了以后音频引擎关不掉：退出流程照常报失败，也告诉窗口它的节目关了', async () => {
  const q = await quit({ outputs: () => Promise.reject(new Error('音频引擎没有响应')) });
  expect(q.result).toBe('退出失败：音频引擎没有响应');
  expect(q.order).toEqual(['停灯光试听', '问外部程序', '看有没有在播', '关节目', '关音频和画面', '告诉窗口节目关了']);
  expect(q.steps.programClosed).toHaveBeenCalledExactlyOnceWith({ version: 1, ownerId: q.window.ownerId });
});

// 修复前（R2 的半成品）：关节目时动作 MIDI 没关掉，退出时被当成灯光没关，弹出“灯光没能关闭 / 返回软件 / 仍然退出”。
it('关节目时只是动作 MIDI 没关掉：不问灯光，照常退出', async () => {
  const q = await quit({ midiClosed: false });
  expect(q.result).toBe('退出了');
  expect(q.order).toEqual(['停灯光试听', '问外部程序', '看有没有在播', '关节目', '关音频和画面', '关外部程序：obs，结束']);
  expect(q.steps.quitWithLightsOn).not.toHaveBeenCalled();
});
