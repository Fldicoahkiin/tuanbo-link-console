import type { ConsoleFollow, LinkObsSnapshot } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, Ma2NetworkStatus } from '@tb/schema';
import type { ConnectionCheck } from '../stores/connection-check-store';
import type { Ma2ConnectionMethod } from '../stores/ma2-mode-store';
import { midiConnectionTargets, usesNativeMidiOutput } from './connection-targets';
import { lightingConnectionDestination, ma2EditingConnectionStatus, midiConnectionStatus, obsConnectionStatus, type ConnectionStatus } from './connection-status';

/** Where the settings for a status live. */
export type StatusDestination = { category: 'ma2' | 'obs' | 'audio' | 'virtual' | 'source' | 'maintenance'; focus?: 'audio-output' | 'lighting-mtc' | 'obs-connection' | 'ma2-connection' };
export type StatusRow = ConnectionStatus & { id: string; name: string; destination: StatusDestination };
export type StatusOverview = { name: '音频' | '视频' | '灯光' | '编辑灯光'; status: ConnectionStatus | undefined; destination: StatusDestination };

type Process = { status: string; error?: string | null | undefined };
type Port = { id: string; name: string; direction: 'input' | 'output'; state: string; connection?: string };
export type StatusCenterInput = {
  project: LinkProject | null;
  profile: IntegrationProfile | null;
  method: Ma2ConnectionMethod;
  local: { status: 'disconnected' | 'connecting' | 'ready' | 'error'; error: string | null };
  obs: LinkObsSnapshot;
  processes: { p1: Process; ma2: Process; ma3d: Process };
  midiPorts: readonly Port[];
  nativeDevices: { midiOutputs: readonly { name: string }[] } | null;
  nativeDeviceError: string | null;
  checks: Readonly<Record<string, ConnectionCheck>>;
  network: Ma2NetworkStatus | null;
  networkError: string | null;
  player: { status: string; mtcSending: boolean; mtcConnectionFailed: boolean };
  /** Whether the console runs with the playing song, as last read back. */
  follow: ConsoleFollow;
};
export type StatusCenter = { rows: StatusRow[]; overview: StatusOverview[]; midiTargets: ReturnType<typeof midiConnectionTargets> };
/** The details panel lists the rows by device, in the order of the top bar (音频, 视频, 灯光). */
export type StatusGroup = { id: 'audio' | 'obs' | 'ma2' | 'other'; name: string; rows: StatusRow[] };

const checkLabel = { checking: '连接中', ready: '已就绪', error: '待处理', skipped: '未启用' };
/** A one-click connection result stands for the row until the live state says otherwise. */
function checked(row: StatusRow, check: ConnectionCheck | undefined): StatusRow {
  if (check?.state === 'waiting' || check?.state === 'blocked') return { ...row, state: 'idle', value: check.state === 'waiting' ? '等待中' : '未执行', detail: check.detail };
  return check ? { ...row, state: check.state, value: checkLabel[check.state], detail: check.detail } : row;
}

/** The lighting status while the song's timecode goes out: whether the console follows it, when that can be read. */
export function consoleFollowStatus(follow: ConsoleFollow): ConnectionStatus {
  switch (follow.state) {
    case 'following': return { state: 'ready', value: '控台在跟', detail: `时间码已发出，控台在跟着跑：${follow.detail}` };
    case 'not-following': return { state: 'error', value: '控台没在跟', detail: `时间码已发出，但控台没有跟着跑：${follow.detail}。音乐照常播放；请看控台的时间码窗口和 TC Slot 设置` };
    case 'checking': return { state: 'ready', value: '时间码已发出', detail: `正在核对控台在不在跟：${follow.detail}` };
    case 'unknown': return { state: 'ready', value: '时间码已发出', detail: `控台有没有跟着跑无法确认：${follow.detail}` };
  }
}

/**
 * Every device and output status the windows show, in one place (root cause 5–7 of the 2026-10-29
 * review): the top bar, its details and the settings read these rows, so one state has one word and
 * one colour everywhere.
 */
export function statusCenter(input: StatusCenterInput): StatusCenter {
  const { project, profile, method, local, obs, processes, checks, network, networkError } = input;
  const internal = project?.playbackSource === 'internal';
  const row = (id: string, name: string, destination: StatusDestination, status: ConnectionStatus): StatusRow => ({ id, name, destination, ...status });
  const rows: StatusRow[] = [
    checked(row('ma2-app', 'MA2 onPC 程序', { category: 'ma2' }, { value: processes.ma2.status === 'running' ? '运行中' : '未运行', state: processes.ma2.status === 'running' ? 'ready' : 'idle', detail: processes.ma2.error ?? '一键连接会启动选好的本机 onPC；网络通信另外检查' }), checks['ma2-app']),
    checked(row('ma3d', 'MA 3D 预演', { category: 'ma2' }, { value: processes.ma3d.status === 'running' ? '运行中' : '未运行', state: processes.ma3d.status === 'running' ? 'ready' : 'idle', detail: processes.ma3d.error ?? '一键连接会启动选好的 MA 3D；请在 MA 3D 里加入对应控台的 Session' }), checks.ma3d),
    row('obs', 'OBS 控制', { category: 'obs' }, obsConnectionStatus(obs)),
    checked(row('preview', 'OBS 预览', { category: 'obs' }, { value: obs.status === 'connected' ? '未检查' : '待 OBS 连接', state: 'idle', detail: '一键连接会检查内置组件，并接收 OBS 预览画面' }), obs.status === 'connected' ? checks.preview : undefined),
    checked(row('audio', '音频输出', { category: 'audio' }, { value: '检测中', state: 'idle', detail: '检查选好的声音输出设备' }), checks.audio),
    checked(row('midi', '系统 MIDI', { category: 'audio' }, { value: '检测中', state: 'idle', detail: '检查系统 MIDI 服务与驱动' }), checks.midi),
    checked(row('loop', '虚拟 MIDI', { category: 'virtual' }, { value: '未检查', state: 'idle', detail: '软件之间传 MIDI 用；实体 MIDI 接口不受影响' }), checks.loop),
    checked(row('p1', 'P1 播放器', { category: 'source' }, { value: internal || !project ? '未启用' : processes.p1.status === 'running' ? '运行中' : '未运行', state: internal || !project ? 'skipped' : processes.p1.status === 'running' ? 'ready' : 'idle', detail: internal ? '当前由联动台播放，不需要启动 P1' : processes.p1.error ?? '跟随 P1 时会启动 P1，并接收它发来的时间码' }), internal || !project ? undefined : checks.p1),
    checked(row('ma2', 'MA2 网络', { category: 'ma2' }, { value: method !== 'network' ? '未启用' : network?.state === 'connected' ? '已连接' : checks.ma2?.state === 'checking' ? '连接中' : '未连接', state: method !== 'network' ? 'skipped' : network?.state === 'connected' ? 'ready' : checks.ma2?.state === 'checking' ? 'checking' : networkError || network?.error || checks.ma2?.state === 'error' ? 'error' : 'idle', detail: method !== 'network' ? '当前使用 ' + (method === 'local' ? '本机 onPC' : 'MIDI') : networkError ?? network?.error ?? checks.ma2?.detail ?? '一键连接会连接已保存的控台；没保存过时，会自动找局域网里唯一的一台控台' }), method === 'network' && checks.ma2?.state !== 'ready' ? checks.ma2 : undefined),
    checked(row('bridge', 'MA2 工程通信', { category: 'ma2' }, { value: method === 'midi' ? '未启用' : method === 'local' && local.status === 'ready' ? '已响应' : method === 'network' && network?.state !== 'connected' ? '待网络连接' : '未检查', state: method === 'midi' ? 'skipped' : method === 'local' && local.status === 'ready' ? 'ready' : 'idle', detail: method === 'midi' ? '仅 MIDI 时不读写控台工程' : local.error ?? '另外检查能否读写控台，网络登录成功不代表这一项已就绪' }), method === 'midi' || method === 'network' && network?.state !== 'connected' ? undefined : checks.bridge)
  ];
  for (const [id, name] of [['discovery', '程序识别'], ['profile', '连接配置'], ['obs-inventory', 'OBS 场景清单']] as const) {
    if (checks[id]?.state === 'error') rows.unshift(checked(row(id, name, { category: id === 'obs-inventory' ? 'obs' : 'maintenance' }, { value: '待处理', state: 'error', detail: '' }), checks[id]));
  }
  const midiTargets = midiConnectionTargets(profile, project);
  for (const target of midiTargets) {
    const mapped = profile?.midiPortProfiles.find(port => port.id === target.id && port.direction === target.direction);
    const matching = input.midiPorts.filter(port => port.name === mapped?.portName && port.direction === target.direction && port.state === 'connected');
    const native = usesNativeMidiOutput(project, target.direction);
    const available = native ? input.nativeDevices?.midiOutputs.filter(port => port.name === mapped?.portName).length === 1 : matching.length === 1;
    const open = !native && available && matching[0]?.connection === 'open';
    const id = 'port:' + target.id;
    rows.push(row(id, target.name, { category: 'audio' }, midiConnectionStatus({ required: target.required, portName: mapped?.portName, available, open, native, check: checks[id],
      inventoryPending: native && input.nativeDevices === null && input.nativeDeviceError === null, systemError: checks.midi?.state === 'error' ? checks.midi.detail : undefined })));
  }
  const find = (id: string): StatusRow | undefined => rows.find(entry => entry.id === id);
  const playing = input.player.status === 'playing';
  const lightingPort = find(`port:${profile?.internalPlayer?.mtcOutputPortProfileId ?? 'internal-mtc-output'}`);
  const lighting: ConnectionStatus = playing && input.player.mtcSending ? consoleFollowStatus(input.follow)
    : playing && input.player.mtcConnectionFailed ? { state: 'error', value: '没发出', detail: '音乐照常播放，但灯光时间码没有发出去' }
      : lightingPort ?? { state: 'skipped', value: '未启用', detail: '当前工程没有设置灯光输出' };
  const audio = internal && playing ? { state: 'ready' as const, value: '播放中', detail: '联动台正在播放音乐' } : internal || !project ? find('audio') : find('p1');
  const overview: StatusOverview[] = [
    { name: '音频', status: audio, destination: internal || !project ? { category: 'audio', focus: 'audio-output' } : { category: 'source' } },
    { name: '视频', status: find('obs'), destination: { category: 'obs', focus: 'obs-connection' } },
    { name: '灯光', status: lighting, destination: lightingConnectionDestination },
    { name: '编辑灯光', status: ma2EditingConnectionStatus({ method, network, networkError, local, bridge: checks.bridge }), destination: { category: 'ma2', focus: 'ma2-connection' } }
  ];
  return { rows, overview, midiTargets };
}

function statusGroupOf(row: StatusRow): StatusGroup['id'] {
  switch (row.destination.category) {
    case 'audio': case 'virtual': return 'audio';
    case 'obs': return 'obs';
    case 'ma2': return 'ma2';
    case 'source': case 'maintenance': return 'other';
  }
}

/** The rows grouped by the device they belong to, which is where their settings live; empty groups are left out. */
export function statusGroups(rows: readonly StatusRow[]): StatusGroup[] {
  const names: Record<StatusGroup['id'], string> = { audio: '音频与 MIDI', obs: '画面（OBS）', ma2: '灯光（MA2）', other: '其他' };
  return (['audio', 'obs', 'ma2', 'other'] as const)
    .map(id => ({ id, name: names[id], rows: rows.filter(row => statusGroupOf(row) === id) }))
    .filter(group => group.rows.length > 0);
}
