import { expect, it } from 'vitest';
import { createEmptyLinkProject, type ObsPictureFollow, type ObsPictureItem } from '@tb/schema';
import { statusCenter, statusGroups, type StatusCenterInput } from './status-center';
import { liveChecks, SHOW_WAIT_BASIS } from './check-basis';
import type { ConnectionCheck } from '../stores/connection-check-store';
import { showGate, type ShowState } from '@tb/core/link';

function input(patch: Partial<StatusCenterInput> = {}): StatusCenterInput {
  const project = createEmptyLinkProject('状态中心'); project.playbackSource = 'internal';
  return { project, profile: null, method: 'network', local: { status: 'disconnected', error: null },
    obs: { status: 'connected', obsVersion: '31', webSocketVersion: '5', error: null },
    processes: { p1: { status: 'stopped' }, ma2: { status: 'stopped' }, ma3d: { status: 'stopped' } },
    midiPorts: [], nativeDevices: { midiOutputs: [] }, nativeDeviceError: null, checks: {},
    network: { state: 'connected', settings: null, passwordSaved: false, version: '3.3.4.3', error: null }, networkError: null,
    player: { status: 'stopped', mtcSending: false, mtcConnectionFailed: false },
    follow: { state: 'unknown', detail: '播放时核对控台在不在跟', misses: 0 }, ...patch };
}
const lighting = (value: StatusCenterInput) => statusCenter(value).overview.find(entry => entry.name === '灯光')!.status!;

it('播放发时间码时，灯光一栏写控台在不在跟；没在跟标红，音乐照常', () => {
  const playing = { status: 'playing', mtcSending: true, mtcConnectionFailed: false };
  expect(lighting(input({ player: playing, follow: { state: 'following', detail: '执行器 1000.101 在 Cue 3，和时间线一致', misses: 0 } })))
    .toEqual({ state: 'ready', value: '控台在跟', detail: '时间码已发出，控台在跟着跑：执行器 1000.101 在 Cue 3，和时间线一致' });
  const missing = lighting(input({ player: playing, follow: { state: 'not-following', detail: '执行器 1000.101 没在跑', misses: 2 } }));
  expect(missing).toMatchObject({ state: 'error', value: '控台没在跟' });
  expect(missing.detail).toContain('音乐照常播放');
  expect(lighting(input({ player: playing, follow: { state: 'unknown', detail: '只接了 MIDI 线', misses: 0 } })))
    .toMatchObject({ state: 'ready', value: '时间码已发出', detail: '控台有没有跟着跑无法确认：只接了 MIDI 线' });
});

it('时间码没发出时写没发出；停着时看时间码接口', () => {
  expect(lighting(input({ player: { status: 'playing', mtcSending: false, mtcConnectionFailed: true } }))).toMatchObject({ state: 'error', value: '没发出' });
  expect(lighting(input())).toMatchObject({ state: 'skipped', value: '未启用' });
});

it('顶栏和详细用同一份状态：每一栏都能找到去哪里设置', () => {
  const center = statusCenter(input({ method: 'midi' }));
  expect(center.overview.map(entry => [entry.name, entry.destination.category])).toEqual([['音频', 'audio'], ['视频', 'obs'], ['灯光', 'audio'], ['编辑灯光', 'ma2']]);
  expect(center.overview.find(entry => entry.name === '编辑灯光')!.status).toMatchObject({ state: 'skipped', value: '未启用' });
  expect(center.rows.find(row => row.id === 'ma2')).toMatchObject({ state: 'skipped', value: '未启用', detail: '当前使用 MIDI' });
  expect(center.rows.find(row => row.id === 'p1')).toMatchObject({ state: 'skipped' });
});

it('一键连接的结果在详细里显示；等待和没执行的步骤不冒充成功', () => {
  const center = statusCenter(input({ checks: { audio: { state: 'waiting', detail: '等前面的步骤完成', checkedAt: 1 }, midi: { state: 'error', detail: 'MIDI 服务不可用', checkedAt: 1 } } }));
  expect(center.rows.find(row => row.id === 'audio')).toMatchObject({ state: 'idle', value: '等待中' });
  expect(center.rows.find(row => row.id === 'midi')).toMatchObject({ state: 'error', value: '待处理', detail: 'MIDI 服务不可用' });
});

it('详细按设备分组：音频与 MIDI、画面、灯光、其他；每一行都在且只在一组里', () => {
  const center = statusCenter(input({ checks: { discovery: { state: 'error', detail: '找不到 OBS', checkedAt: 1 } } }));
  const groups = statusGroups(center.rows);
  expect(groups.map(group => group.name)).toEqual(['音频与 MIDI', '画面（OBS）', '灯光（MA2）', '其他']);
  expect(groups.find(group => group.id === 'audio')!.rows.map(row => row.id)).toEqual(expect.arrayContaining(['audio', 'midi', 'loop']));
  expect(groups.find(group => group.id === 'obs')!.rows.map(row => row.id)).toEqual(['obs', 'preview']);
  expect(groups.find(group => group.id === 'ma2')!.rows.map(row => row.id)).toEqual(['ma2-app', 'ma3d', 'ma2', 'bridge']);
  expect(groups.find(group => group.id === 'other')!.rows.map(row => row.id)).toEqual(['discovery', 'p1']);
  expect(groups.flatMap(group => group.rows).length).toBe(center.rows.length);
  expect(statusGroups(center.rows.filter(row => row.destination.category !== 'obs')).map(group => group.id)).toEqual(['audio', 'ma2', 'other']);
});

/** The checks as the top bar gets them: only the one-click results that still stand on the live sources (check-basis.ts). */
function live(value: StatusCenterInput, checks: Record<string, ConnectionCheck>, show: ShowState = { phase: 'idle', program: null }): StatusCenterInput {
  const process = (status: 'running' | 'notRunning', pid: number | null) => ({ status, pid, startTime: null });
  return { ...value, checks: liveChecks(checks, { obs: value.obs, network: value.network,
    processes: { p1: process('notRunning', null), ma2: process('running', 41), ma3d: process('notRunning', null) }, connectionsCheck: showGate('connections.check', show) }) };
}
const bridgeRow = (value: StatusCenterInput) => statusCenter(value).rows.find(row => row.id === 'bridge')!;
const editing = (value: StatusCenterInput) => statusCenter(value).overview.find(entry => entry.name === '编辑灯光')!.status!;
const consoleAt = (connection: number): Partial<StatusCenterInput> => ({ network: { state: 'connected', settings: null, passwordSaved: false, version: '3.3.4.3', error: null, connection } });

it('S11：控台重新连接后，上一次连接的一键检查结果不再显示，顶栏按实时状态写', () => {
  const failed: Record<string, ConnectionCheck> = { bridge: { state: 'error', detail: '插件没有响应', checkedAt: 1, basis: 'ma2:3|process:41:' } };
  expect(bridgeRow(live(input(consoleAt(3)), failed))).toMatchObject({ state: 'error', detail: '插件没有响应' });
  expect(editing(live(input(consoleAt(3)), failed))).toMatchObject({ value: '读写异常' });
  expect(bridgeRow(live(input(consoleAt(5)), failed))).toMatchObject({ state: 'idle', value: '未检查' });
  expect(editing(live(input(consoleAt(5)), failed))).toEqual({ state: 'ready', value: '已连接', detail: '控台网络已连接；每次读写时还会再检查通信和内容' });
});

it('S11：onPC 退出又启动后，上一次“已就绪”不再显示；OBS 重连后预览结果也一样', () => {
  const obs = (connection: number): Partial<StatusCenterInput> => ({ obs: { status: 'connected', obsVersion: '31', webSocketVersion: '5', error: null, connection } });
  const started: Record<string, ConnectionCheck> = { 'ma2-app': { state: 'ready', detail: 'MA2 onPC 已运行', checkedAt: 1, basis: 'process:41:' },
    preview: { state: 'ready', detail: '已收到 OBS 预览画面', checkedAt: 1, basis: 'obs:2' } };
  const row = (value: StatusCenterInput, id: string) => statusCenter(value).rows.find(entry => entry.id === id);
  expect(row(live(input(obs(2)), started), 'preview')).toMatchObject({ state: 'ready', value: '已就绪' });
  expect(row(live(input(obs(2)), started), 'ma2-app')).toMatchObject({ state: 'ready', value: '已就绪' });
  const restarted = { ...started, 'ma2-app': { ...started['ma2-app']!, basis: 'process:40:' } };
  expect(row(live(input(obs(2)), restarted), 'ma2-app')).toMatchObject({ value: '未运行' });
  expect(row(live(input(obs(3)), started), 'preview')).toMatchObject({ state: 'idle', value: '未检查' });
});

it('S11：节目在走时一键连接留下的等待，写节目此刻的阶段；暂停或停止后等待消失', () => {
  const waiting: Record<string, ConnectionCheck> = { bridge: { state: 'waiting', detail: '节目在走，暂停或停止后再检查连接。', checkedAt: 1, basis: SHOW_WAIT_BASIS } };
  const moving: ShowState = { phase: 'running', source: 'internal', itemId: 'a', program: null };
  expect(bridgeRow(live(input(consoleAt(0)), waiting, moving))).toMatchObject({ state: 'idle', value: '等待中', detail: '节目在走，暂停或停止后再检查连接。' });
  expect(bridgeRow(live(input(consoleAt(0)), waiting, { ...moving, phase: 'stopping' }))).toMatchObject({ value: '等待中', detail: '节目在停止，停下以后再检查连接。' });
  expect(bridgeRow(live(input(consoleAt(0)), waiting, { phase: 'held', source: 'internal', itemId: 'a', reason: 'paused', program: null }))).toMatchObject({ value: '未检查' });
  expect(bridgeRow(live(input(consoleAt(0)), waiting))).toMatchObject({ value: '未检查' });
});

it('M8 关灯读回：还在运行的标黄（详情一行，停着时灯光一栏也黄）；无法确认只在详情里一句，不标黄红；什么都没有就不出现', () => {
  const offRow = (value: StatusCenterInput) => statusCenter(value).rows.find(entry => entry.id === 'lighting-off');
  expect(offRow(input())).toBeUndefined();
  expect(offRow(input({ lightingOff: { running: [], unconfirmed: [] } }))).toBeUndefined();
  const running = input({ lightingOff: { running: [{ executor: '1000.101', song: { itemId: 'a', title: '开场' } }], unconfirmed: [] } });
  expect(offRow(running)).toMatchObject({ state: 'warning', value: '还在运行', name: '关灯读回',
    detail: '关灯已发出，但控台读回「开场」的执行器 1000.101 还在运行（也可能是关灯的渐变还没走完）。再按一次停止会重发。' });
  expect(lighting(running)).toMatchObject({ state: 'warning', value: '还在运行' });
  // While a song plays the lighting column says whether the console follows it, as before.
  expect(lighting({ ...running, player: { status: 'playing', mtcSending: true, mtcConnectionFailed: false } })).toMatchObject({ value: '时间码已发出' });
  const unconfirmed = input({ lightingOff: { running: [], unconfirmed: [{ executor: '1000.1', song: null, reason: '实时推杆读取超时，请重新连接' }, { executor: '1000.2', song: null, reason: '实时推杆读取超时，请重新连接' }] } });
  expect(offRow(unconfirmed)).toMatchObject({ state: 'idle', value: '无法确认', detail: '控台已收到关灯指令；执行器 1000.1、1000.2 有没有真的关掉无法确认。原因：实时推杆读取超时，请重新连接。' });
  expect(lighting(unconfirmed)).toEqual(lighting(input()));
});

it('这首歌的画面按项列出：一项出错只标这一项，其余照常；补了一次的标黄；OBS 断了看 OBS 那一栏（2026-11-10 第 2 题，R5）', () => {
  const video = (value: StatusCenterInput) => statusCenter(value).overview.find(entry => entry.name === '视频')!.status!;
  const playing = (pictureItems: NonNullable<StatusCenterInput['player']['pictureItems']>) => ({ status: 'playing', mtcSending: false, mtcConnectionFailed: false, pictureItems });
  const failed = { id: 'program', scope: 'item', state: 'limit', detail: '切换节目画面：这一项画面补发了一次还是没成功' } as const;
  const repaired = { id: 'show:a', scope: 'item', state: 'repairing', detail: '显示来源 · 贴纸：OBS 没有执行，已按现在应有的画面补发一次（第 1 次，最多 1 次）' } as const;
  const center = statusCenter(input({ player: playing([failed, repaired]) }));
  expect(center.rows.find(row => row.id === 'picture')).toMatchObject({ state: 'error', value: '1 项出错', detail: `${failed.detail}；${repaired.detail}` });
  expect(video(input({ player: playing([failed]) }))).toMatchObject({ state: 'error', value: '1 项出错' });
  expect(video(input({ player: playing([repaired]) }))).toMatchObject({ state: 'warning', value: '补了一次' });
  // Waiting parts and the connection item are not the song's parts; nothing in red, the OBS row stands.
  expect(statusCenter(input({ player: playing([{ id: 'obs.connection', scope: 'channel', state: 'failed', detail: 'OBS 连接中断' }]) })).rows.some(row => row.id === 'picture')).toBe(false);
  // A lost OBS is the OBS row's, not the picture's.
  const lost = input({ obs: { status: 'disconnected', obsVersion: null, webSocketVersion: null, error: '连接断开' }, player: playing([failed]) });
  expect(video(lost)).toEqual(statusCenter(lost).rows.find(row => row.id === 'obs'));
  // Stopped: nothing listed.
  expect(statusCenter(input({ player: { ...playing([failed]), status: 'stopped' } })).rows.some(row => row.id === 'picture')).toBe(false);
});

it('画面在不在跟（R8）：和“控台在不在跟”一个写法；读不到是“无法确认”和原因，不算正常；手动接管标黄不标红；出错的项排在前面', () => {
  const picture = (pictureFollow: ObsPictureFollow | null, pictureItems: ObsPictureItem[] = [], status = 'playing') =>
    statusCenter(input({ player: { status, mtcSending: false, mtcConnectionFailed: false, pictureItems, pictureFollow } })).rows.find(row => row.id === 'picture');
  expect(picture({ state: 'following', detail: 'OBS 在播「全景」，和时间线一致' })).toMatchObject({ state: 'ready', value: '画面在跟', detail: 'OBS 在播「全景」，和时间线一致' });
  expect(picture({ state: 'not-following', detail: 'OBS 现在播的是「特写」，按时间线这时应该是「全景」' })).toMatchObject({ state: 'error', value: '画面没在跟',
    detail: 'OBS 的画面和时间线对不上：OBS 现在播的是「特写」，按时间线这时应该是「全景」。音乐照常播放；请看 OBS 现在播的场景和素材' });
  expect(picture({ state: 'unknown', detail: '读不到 OBS 现在的画面：请求超时' })).toMatchObject({ state: 'idle', value: '无法确认', detail: '无法确认画面在不在跟：读不到 OBS 现在的画面：请求超时' });
  const taken = { state: 'taken-over', detail: '有人在 OBS 里切到了「手动」，联动台不切回去；到下一段画面按时间线照常切换' } as const;
  expect(picture(taken)).toMatchObject({ state: 'warning', value: '画面被手动接管', detail: taken.detail });
  expect(picture({ state: 'checking', detail: '刚切过画面，稍后核对' })).toMatchObject({ state: 'ready', value: '正在核对画面' });
  // A red part stays first; a yellow one comes after a takeover; a reading that cannot confirm does not hide a yellow part.
  const red: ObsPictureItem = { id: 'music', scope: 'item', state: 'failed', detail: '当前场景「手动」里没有联动台的音乐' };
  const yellow: ObsPictureItem = { id: 'drift:a', scope: 'item', state: 'not-aligned', detail: '素材“开场”和音乐差了 400 ms，正在按音乐校正' };
  expect(picture(taken, [red])).toMatchObject({ state: 'error', value: '1 项出错', detail: red.detail });
  expect(picture(taken, [yellow])).toMatchObject({ state: 'warning', value: '画面被手动接管', detail: `${taken.detail}；${yellow.detail}` });
  expect(picture({ state: 'unknown', detail: '读不到' }, [yellow])).toMatchObject({ state: 'warning', value: '没对齐' });
  // Not read back yet, or stopped (R14): as before R8.
  expect(picture(null)).toBeUndefined();
  expect(picture({ state: 'not-following', detail: '对不上' }, [], 'stopped')).toBeUndefined();
});

it('M5：演出中控台断了在自动重新登录是等待（黄，第几次），一键连接的旧结果不盖过它；到上限或要人处理才标红', () => {
  const since = 1_000_000;
  const ma2 = (network: StatusCenterInput['network'], checks: StatusCenterInput['checks'] = {}) => statusCenter(input({ network, checks })).rows.find(row => row.id === 'ma2')!;
  const down = { state: 'disconnected' as const, settings: null, passwordSaved: false, version: null, error: null };
  const waiting = ma2({ ...down, relogin: { kind: 'relogin', attempt: 3, since, reason: 'MA2 命令端口连接失败' } }, { ma2: { state: 'ready', detail: '一键连接通过', checkedAt: 1 } });
  expect(waiting).toMatchObject({ state: 'warning', value: '自动重新登录（第 3 次）' });
  expect(waiting.detail).toBe('控台断开了，正在自动重新登录（第 3 次），最多试 5 分钟。登上以后关灯和按键照常，不会自动重新读取控台。原因：MA2 命令端口连接失败');
  const limit = '控台断线 5 分钟还没能自动重新登录，请检查控台和网络后手动连接';
  expect(ma2({ ...down, error: limit, relogin: { kind: 'stopped', reason: limit, limit: true } })).toMatchObject({ state: 'error', value: '自动重新登录没成功', detail: limit });
  expect(ma2({ ...down, error: '控台上的 Show 换了', relogin: { kind: 'stopped', reason: '控台上的 Show 换了', limit: false } }))
    .toMatchObject({ state: 'error', value: '需要手动连接', detail: '控台没有再自动重新登录：控台上的 Show 换了' });
  const plugin = '演出还没停止，控台上的联动台插件不见了（控台载入过 Show 或重启过），停止以后会自动重新装上。这期间关灯和网页遥控照常，走控台插件的按键、同步和读取控台先等着。';
  expect(ma2({ ...down, state: 'connected', version: '3.3.4.3', pluginWait: plugin })).toMatchObject({ state: 'warning', value: '已连接，插件停止后再装', detail: plugin });
  // The overview's lighting edit entry says the same.
  expect(statusCenter(input({ network: { ...down, relogin: { kind: 'relogin', attempt: 1, since, reason: '断了' } } })).overview.find(entry => entry.name === '编辑灯光')!.status)
    .toMatchObject({ state: 'warning', value: '自动重新登录（第 1 次）' });
});
