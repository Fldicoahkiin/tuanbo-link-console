import { expect, it } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { statusCenter, statusGroups, type StatusCenterInput } from './status-center';

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
