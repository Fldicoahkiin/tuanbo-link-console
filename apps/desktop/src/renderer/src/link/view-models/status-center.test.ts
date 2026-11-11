import { expect, it } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
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
