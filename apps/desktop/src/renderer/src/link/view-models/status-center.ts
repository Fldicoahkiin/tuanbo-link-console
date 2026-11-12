import { lightsStillRunningText, lightsUnconfirmedText, type ConsoleFollow, type LightingOffCheck, type LinkObsSnapshot } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, Ma2NetworkStatus, ObsPictureFollow, ObsPictureItem, P1FollowState } from '@tb/schema';
import type { ConnectionCheck } from '../stores/connection-check-store';
import type { Ma2ConnectionMethod } from '../stores/ma2-mode-store';
import { midiConnectionTargets, usesNativeMidiOutput } from './connection-targets';
import { lightingConnectionDestination, ma2EditingConnectionStatus, ma2NetworkWaitStatus, midiConnectionStatus, obsConnectionStatus, type ConnectionStatus } from './connection-status';

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
  /** `pictureItems`: the playing song's picture, part by part, as the picture host lists them (R5). `pictureFollow`:
   * whether OBS shows what the timeline wants, as read back (R8). */
  player: { status: string; mtcSending: boolean; mtcConnectionFailed: boolean; pictureItems?: readonly ObsPictureItem[]; pictureFollow?: ObsPictureFollow | null };
  /** Whether the console runs with the playing song, as last read back. */
  follow: ConsoleFollow;
  /** The lights-off read-back (M8): absent or empty, nothing is shown. */
  lightingOff?: LightingOffCheck;
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
  // Logging in again on its own during the show, or a plugin waiting for the stop (M5): the live state, not the last check.
  const ma2Wait = method === 'network' ? ma2NetworkWaitStatus(network) : null;
  const rows: StatusRow[] = [
    checked(row('ma2-app', 'MA2 onPC 程序', { category: 'ma2' }, { value: processes.ma2.status === 'running' ? '运行中' : '未运行', state: processes.ma2.status === 'running' ? 'ready' : 'idle', detail: processes.ma2.error ?? '一键连接会启动选好的本机 onPC；网络通信另外检查' }), checks['ma2-app']),
    checked(row('ma3d', 'MA 3D 预演', { category: 'ma2' }, { value: processes.ma3d.status === 'running' ? '运行中' : '未运行', state: processes.ma3d.status === 'running' ? 'ready' : 'idle', detail: processes.ma3d.error ?? '一键连接会启动选好的 MA 3D；请在 MA 3D 里加入对应控台的 Session' }), checks.ma3d),
    row('obs', 'OBS 控制', { category: 'obs' }, obsConnectionStatus(obs)),
    checked(row('preview', 'OBS 预览', { category: 'obs' }, { value: obs.status === 'connected' ? '未检查' : '待 OBS 连接', state: 'idle', detail: '一键连接会检查内置组件，并接收 OBS 预览画面' }), obs.status === 'connected' ? checks.preview : undefined),
    checked(row('audio', '音频输出', { category: 'audio' }, { value: '检测中', state: 'idle', detail: '检查选好的声音输出设备' }), checks.audio),
    checked(row('midi', '系统 MIDI', { category: 'audio' }, { value: '检测中', state: 'idle', detail: '检查系统 MIDI 服务与驱动' }), checks.midi),
    checked(row('loop', '虚拟 MIDI', { category: 'virtual' }, { value: '未检查', state: 'idle', detail: '软件之间传 MIDI 用；实体 MIDI 接口不受影响' }), checks.loop),
    checked(row('p1', 'P1 播放器', { category: 'source' }, { value: internal || !project ? '未启用' : processes.p1.status === 'running' ? '运行中' : '未运行', state: internal || !project ? 'skipped' : processes.p1.status === 'running' ? 'ready' : 'idle', detail: internal ? '当前由联动台播放，不需要启动 P1' : processes.p1.error ?? '跟随 P1 时会启动 P1，并接收它发来的时间码' }), internal || !project ? undefined : checks.p1),
    ma2Wait ? row('ma2', 'MA2 网络', { category: 'ma2' }, ma2Wait) : checked(row('ma2', 'MA2 网络', { category: 'ma2' }, { value: method !== 'network' ? '未启用' : network?.state === 'connected' ? '已连接' : checks.ma2?.state === 'checking' ? '连接中' : '未连接', state: method !== 'network' ? 'skipped' : network?.state === 'connected' ? 'ready' : checks.ma2?.state === 'checking' ? 'checking' : networkError || network?.error || checks.ma2?.state === 'error' ? 'error' : 'idle', detail: method !== 'network' ? '当前使用 ' + (method === 'local' ? '本机 onPC' : 'MIDI') : networkError ?? network?.error ?? checks.ma2?.detail ?? '一键连接会连接已保存的控台；没保存过时，会自动找局域网里唯一的一台控台' }), method === 'network' && checks.ma2?.state !== 'ready' ? checks.ma2 : undefined),
    checked(row('bridge', 'MA2 工程通信', { category: 'ma2' }, { value: method === 'midi' ? '未启用' : method === 'local' && local.status === 'ready' ? '已响应' : method === 'network' && network?.state !== 'connected' ? '待网络连接' : '未检查', state: method === 'midi' ? 'skipped' : method === 'local' && local.status === 'ready' ? 'ready' : 'idle', detail: method === 'midi' ? '仅 MIDI 时不读写控台工程' : local.error ?? '另外检查能否读写控台，网络登录成功不代表这一项已就绪' }), method === 'midi' || method === 'network' && network?.state !== 'connected' ? undefined : checks.bridge)
  ];
  // M8: an Off read back still running is yellow; one that could not be confirmed is one plain sentence, as before M8.
  const offRunning: ConnectionStatus | null = input.lightingOff?.running.length
    ? { state: 'warning', value: '还在运行', detail: lightsStillRunningText(input.lightingOff.running) } : null;
  const offUnconfirmed = input.lightingOff?.unconfirmed;
  if (offRunning) rows.push(row('lighting-off', '关灯读回', { category: 'ma2' }, offRunning));
  else if (offUnconfirmed?.length) rows.push(row('lighting-off', '关灯读回', { category: 'ma2' }, { state: 'idle', value: '无法确认', detail: lightsUnconfirmedText(offUnconfirmed) }));
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
  const picture = pictureStatus(input.player);
  if (picture) rows.push(row('picture', '这首歌的画面', { category: 'obs' }, picture));
  const find = (id: string): StatusRow | undefined => rows.find(entry => entry.id === id);
  const playing = input.player.status === 'playing';
  const lightingPort = find(`port:${profile?.internalPlayer?.mtcOutputPortProfileId ?? 'internal-mtc-output'}`);
  const lighting: ConnectionStatus = playing && input.player.mtcSending ? consoleFollowStatus(input.follow)
    : playing && input.player.mtcConnectionFailed ? { state: 'error', value: '没发出', detail: '音乐照常播放，但灯光时间码没有发出去' }
      : !playing && offRunning ? offRunning
      : lightingPort ?? { state: 'skipped', value: '未启用', detail: '当前工程没有设置灯光输出' };
  const audio = internal && playing ? { state: 'ready' as const, value: '播放中', detail: '联动台正在播放音乐' } : internal || !project ? find('audio') : find('p1');
  const overview: StatusOverview[] = [
    { name: '音频', status: audio, destination: internal || !project ? { category: 'audio', focus: 'audio-output' } : { category: 'source' } },
    // A connected OBS whose song picture has parts in red shows those; a lost connection is the OBS row's own.
    { name: '视频', status: picture && find('obs')?.state === 'ready' ? picture : find('obs'), destination: { category: 'obs', focus: 'obs-connection' } },
    { name: '灯光', status: lighting, destination: lightingConnectionDestination },
    { name: '编辑灯光', status: ma2EditingConnectionStatus({ method, network, networkError, local, bridge: checks.bridge }), destination: { category: 'ma2', focus: 'ma2-connection' } }
  ];
  return { rows, overview, midiTargets };
}

/** The playing song's picture, from its parts (R5): each failed, unknown or used-up part is red on its own, one being
 * repaired or out of step with the music is yellow; one failing part never fails the rest. None while nothing plays. */
/** Whether the picture follows, as read back (R8), with the same rules as 控台在不在跟: following only on a reading
 * that agreed; one that could not be read is 无法确认 with the reason, never fine; taken over by hand is waiting. */
export function pictureFollowStatus(follow: ObsPictureFollow): ConnectionStatus {
  switch (follow.state) {
    case 'following': return { state: 'ready', value: '画面在跟', detail: follow.detail };
    case 'not-following': return { state: 'error', value: '画面没在跟', detail: `OBS 的画面和时间线对不上：${follow.detail}。音乐照常播放；请看 OBS 现在播的场景和素材` };
    case 'checking': return { state: 'ready', value: '正在核对画面', detail: follow.detail };
    case 'unknown': return { state: 'idle', value: '无法确认', detail: `无法确认画面在不在跟：${follow.detail}` };
    case 'taken-over': return { state: 'warning', value: '画面被手动接管', detail: follow.detail };
  }
}

export function pictureStatus(player: StatusCenterInput['player']): ConnectionStatus | undefined {
  if (!['playing', 'paused', 'preparing'].includes(player.status)) return undefined;
  const parts = (player.pictureItems ?? []).filter(item => item.scope !== 'channel' && item.state !== 'waiting');
  const follow = player.pictureFollow ? pictureFollowStatus(player.pictureFollow) : undefined;
  const red = parts.filter(item => item.state === 'failed' || item.state === 'uncertain' || item.state === 'limit');
  const detail = parts.map(item => item.detail).join('；');
  // Red parts first, then not following, taken over, the yellow parts, cannot confirm, following.
  if (red.length) return { state: 'error', value: `${red.length} 项出错`, detail: follow?.state === 'error' ? `${detail}；${follow.detail}` : detail };
  if (follow?.state === 'error') return follow;
  if (follow?.state === 'warning') return parts.length ? { ...follow, detail: `${follow.detail}；${detail}` } : follow;
  if (parts.length) return { state: 'warning', value: parts.some(item => item.state === 'repairing') ? '补了一次' : '没对齐', detail };
  return follow;
}

/**
 * The main process's P1 follow (0.5.9 P4), as the home page's P1 panel shows it: waiting and a frozen timecode are yellow
 * with their reason; red only for what failed (the input, the song that could not start, the song's action MIDI).
 */
export function p1FollowStatus(follow: P1FollowState | null): ConnectionStatus {
  if (!follow || follow.phase === 'closed') return { state: 'idle', value: 'P1 跟随', detail: '还没接收 P1 的时间码。点「启动并待命」或一键连接后开始接收' };
  if (follow.ownerId === null) return { state: 'warning', value: '还在跟随', detail: `联动台重新打开之前开始的跟随还在继续（工程「${follow.projectName ?? ''}」）` };
  if (follow.input?.state === 'closed') return { state: 'error', value: '收不到时间码', detail: follow.input.reason ?? 'P1 的时间码接口停了，请检查 MIDI 线和接口，再点「启动并待命」' };
  const base = followPhaseStatus(follow);
  const midi = follow.outputs.actionMidi;
  const midiProblem = midi?.state === 'failed' ? midi.reason ?? '动作 MIDI 没准备好' : midi?.fault ?? null;
  return midiProblem && base.state !== 'error' ? { state: 'error', value: '动作 MIDI 出错', detail: `${midiProblem}；${base.detail}` } : base;
}

function followPhaseStatus(follow: P1FollowState): ConnectionStatus {
  const reason = follow.reason;
  switch (follow.phase) {
    case 'closed': case 'standby': return { state: 'idle', value: '正在接收', detail: reason ?? '正在接收 P1 的时间码，还没跟随哪首歌' };
    case 'waiting': return follow.itemId === null
      ? { state: 'warning', value: '等 P1 点歌', detail: reason ?? '在 P1 里点歌，联动台就跟着这首歌' }
      : { state: 'warning', value: '等 P1 播放', detail: reason ?? '等 P1 从头播放这首歌' };
    case 'preparing': return { state: 'checking', value: '准备中', detail: reason ?? 'P1 开始播放了，正在准备这首歌的输出' };
    case 'running': return { state: 'ready', value: '在跟', detail: '跟着 P1 的时间码' };
    case 'frozen': return { state: 'warning', value: '时间码停了', detail: `${reason ?? '收不到连续的时间码，自动 Cue 先停下'}。${follow.mode === 'manual' ? '时间码恢复后点「重新同步」接着跟' : 'P1 继续播放或重新点歌就接着跟'}` };
    case 'takeover': return { state: 'warning', value: '手动接管', detail: reason ?? '不再跟着时间码，Cue 由人来触发' };
    case 'failed': return { state: 'error', value: '没开始', detail: reason ?? '这首歌没有开始，P1 从头播放一首歌时再试' };
  }
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
