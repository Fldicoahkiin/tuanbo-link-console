import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { toUserErrorMessage } from '@tb/core/link';
import { ma2NetworkStatusSchema, loopMidiStatusSchema, type Ma2NetworkStatus } from '@tb/schema';
import { ToolbarMtcStatus } from './ToolbarMtcStatus';
import type { ProjectPlayer } from './ProjectPlayerControls';
import type { SettingsCategory, SettingsFocus } from './settings-navigation';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useLocalMa2Store } from '../stores/ma2-connection-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useConnectionCheckStore, type ConnectionCheck } from '../stores/connection-check-store';
import { midiConnectionTargets, usesNativeMidiOutput } from '../view-models/connection-targets';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { assertAudioOutputAvailable } from '../view-models/audio-output-route';
import { obsConnectionStatus, midiConnectionStatus, ma2EditingConnectionStatus, lightingConnectionDestination, type ConnectionStatus } from '../view-models/connection-status';

type Row = { id: string; name: string; value: string; state: ConnectionStatus['state']; detail: string; category: SettingsCategory };
const statusLabel = { checking: '连接中', ready: '已就绪', error: '待处理', skipped: '未启用' };
function checked(row: Row, check: ConnectionCheck | undefined): Row {
  if (check?.state === 'waiting' || check?.state === 'blocked') return { ...row, state: 'idle', value: check.state === 'waiting' ? '等待中' : '未执行', detail: check.detail };
  return check ? { ...row, state: check.state, value: statusLabel[check.state], detail: check.detail } : row;
}

export function ToolbarConnections({ player, statusHost, onSettings }: { player: ProjectPlayer; statusHost: HTMLDivElement | null; onSettings: (category: SettingsCategory, focus?: SettingsFocus) => void }): JSX.Element {
  const method = useMa2ModeStore(state => state.method);
  const local = useLocalMa2Store();
  const project = useDocumentStore(state => state.project);
  const obs = useIntegrationStore(state => state.obs);
  const p1 = useIntegrationStore(state => state.processes.p1);
  const ma2Program = useIntegrationStore(state => state.processes.ma2);
  const ma3dProgram = useIntegrationStore(state => state.processes.ma3d);
  const profile = useIntegrationStore(state => state.profile);
  const audioRoute = profile?.internalPlayer;
  const ports = useIntegrationStore(state => state.midiPorts);
  const nativeDevices = useIntegrationStore(state => state.nativeDevices);
  const nativeDeviceError = useIntegrationStore(state => state.nativeDeviceError);
  const checks = useConnectionCheckStore(state => state.checks);
  const running = useConnectionCheckStore(state => state.running);
  const lastMtcAt = useRuntimeStore(state => state.lastMtcAt);
  const [now, setNow] = useState(() => performance.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [network, setNetwork] = useState<Ma2NetworkStatus | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const internal = project?.playbackSource === 'internal';
  const targets = useMemo(() => midiConnectionTargets(profile, project), [profile, project]);
  useEffect(() => {
    if (internal) return;
    const timer = setInterval(() => setNow(performance.now()), 500); return () => clearInterval(timer);
  }, [internal]);
  useEffect(() => {
    if (method !== 'network') return;
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try { const status = ma2NetworkStatusSchema.parse(await desktop.getMa2NetworkStatus()); if (alive) { setNetwork(status); setNetworkError(null); timer = setTimeout(() => void read(), 1000); } }
      catch (error) { if (alive) setNetworkError(toUserErrorMessage(error)); }
    };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, [method, running]);
  useEffect(() => {
    let alive = true;
    const inspectAudio = async (): Promise<void> => {
      try {
        await assertAudioOutputAvailable(audioRoute);
        if (!alive || useConnectionCheckStore.getState().running) return;
        useConnectionCheckStore.getState().finish('audio', 'ready', '音频设备可用，播放时开始输出');
      } catch (error) { if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('audio', 'error', toUserErrorMessage(error)); }
    };
    const onAudioChange = (): void => { void inspectAudio(); };
    onAudioChange(); navigator.mediaDevices.addEventListener('devicechange', onAudioChange);
    return () => { alive = false; navigator.mediaDevices.removeEventListener('devicechange', onAudioChange); };
  }, [audioRoute]);
  useEffect(() => {
    let alive = true;
    void desktop.loopMidi('detect').then(value => {
      const status = loopMidiStatusSchema.parse(value);
      if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('loop', status.state === 'running' ? 'ready' : profile?.loopMidi?.autoStart ? 'error' : 'skipped', status.state === 'running' ? 'loopMIDI 已运行，端口另外检查' : profile?.loopMidi?.autoStart ? '虚拟 MIDI 未启动，点“一键连接”启动' : '没有开启虚拟 MIDI 自动启动；用实体 MIDI 接口不受影响');
    }).catch(error => { if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('loop', 'error', toUserErrorMessage(error)); });
    return () => { alive = false; };
  }, [profile?.loopMidi?.autoStart]);
  const rows: Row[] = [
    checked({ id: 'ma2-app', name: 'MA2 onPC 程序', value: ma2Program.status === 'running' ? '运行中' : '未运行', state: ma2Program.status === 'running' ? 'ready' : 'idle', detail: ma2Program.error ?? '一键连接会启动选好的本机 onPC；网络通信另外检查', category: 'ma2' }, checks['ma2-app']),
    checked({ id: 'ma3d', name: 'MA 3D 预演', value: ma3dProgram.status === 'running' ? '运行中' : '未运行', state: ma3dProgram.status === 'running' ? 'ready' : 'idle', detail: ma3dProgram.error ?? '一键连接会启动选好的 MA 3D；请在 MA 3D 里加入对应控台的 Session', category: 'ma2' }, checks.ma3d),
    { id: 'obs', name: 'OBS 控制', ...obsConnectionStatus(obs), category: 'obs' },
    checked({ id: 'preview', name: 'OBS 预览', value: obs.status === 'connected' ? '未检查' : '待 OBS 连接', state: 'idle', detail: '一键连接会检查内置组件，并接收 OBS 预览画面', category: 'obs' }, obs.status === 'connected' ? checks.preview : undefined),
    checked({ id: 'audio', name: '音频输出', value: '检测中', state: 'idle', detail: '检查选好的声音输出设备', category: 'audio' }, checks.audio),
    checked({ id: 'midi', name: '系统 MIDI', value: '检测中', state: 'idle', detail: '检查系统 MIDI 服务与驱动', category: 'audio' }, checks.midi),
    checked({ id: 'loop', name: '虚拟 MIDI', value: '未检查', state: 'idle', detail: '软件之间传 MIDI 用；实体 MIDI 接口不受影响', category: 'virtual' }, checks.loop),
    checked({ id: 'p1', name: 'P1 播放器', value: internal || !project ? '未启用' : p1.status === 'running' ? '运行中' : '未运行', state: internal || !project ? 'skipped' : p1.status === 'running' ? 'ready' : 'idle', detail: internal ? '当前由联动台播放，不需要启动 P1' : p1.error ?? '跟随 P1 时会启动 P1，并接收它发来的时间码', category: 'source' }, internal || !project ? undefined : checks.p1),
    checked({ id: 'ma2', name: 'MA2 网络', value: method !== 'network' ? '未启用' : network?.state === 'connected' ? '已连接' : checks.ma2?.state === 'checking' ? '连接中' : '未连接', state: method !== 'network' ? 'skipped' : network?.state === 'connected' ? 'ready' : checks.ma2?.state === 'checking' ? 'checking' : networkError || network?.error || checks.ma2?.state === 'error' ? 'error' : 'idle', detail: method !== 'network' ? '当前使用 ' + (method === 'local' ? '本机 onPC' : 'MIDI') : networkError ?? network?.error ?? checks.ma2?.detail ?? '一键连接会连接已保存的控台；没保存过时，会自动找局域网里唯一的一台控台', category: 'ma2' }, method === 'network' && checks.ma2?.state !== 'ready' ? checks.ma2 : undefined),
    checked({ id: 'bridge', name: 'MA2 工程通信', value: method === 'midi' ? '未启用' : method === 'local' && local.status === 'ready' ? '已响应' : method === 'network' && network?.state !== 'connected' ? '待网络连接' : '未检查', state: method === 'midi' ? 'skipped' : method === 'local' && local.status === 'ready' ? 'ready' : 'idle', detail: method === 'midi' ? '仅 MIDI 时不读写控台工程' : local.error ?? '另外检查能否读写控台，网络登录成功不代表这一项已就绪', category: 'ma2' }, method === 'midi' || method === 'network' && network?.state !== 'connected' ? undefined : checks.bridge)
  ];
  for (const [id, name] of [['discovery', '程序识别'], ['profile', '连接配置'], ['obs-inventory', 'OBS 场景清单']] as const) {
    if (checks[id]?.state === 'error') rows.unshift(checked({ id, name, value: '待处理', state: 'error', detail: '', category: id === 'obs-inventory' ? 'obs' : 'maintenance' }, checks[id]));
  }
  for (const target of targets) {
    const mapped = profile?.midiPortProfiles.find(port => port.id === target.id && port.direction === target.direction);
    const matching = ports.filter(port => port.name === mapped?.portName && port.direction === target.direction && port.state === 'connected');
    const nativeOutput = usesNativeMidiOutput(project, target.direction);
    const available = nativeOutput ? nativeDevices?.midiOutputs.filter(port => port.name === mapped?.portName).length === 1 : matching.length === 1;
    const open = !nativeOutput && available && matching[0]?.connection === 'open';
    const key = 'port:' + target.id;
    const check = checks[key];
    rows.push({ id: key, name: target.name, ...midiConnectionStatus({ required: target.required, portName: mapped?.portName, available, open, native: nativeOutput, check, inventoryPending: nativeOutput && nativeDevices === null && nativeDeviceError === null, systemError: checks.midi?.state === 'error' ? checks.midi.detail : undefined }), category: 'audio' });
  }
  const detail = rows.find(row => row.id === selected);
  const receiving = lastMtcAt !== null && now >= lastMtcAt && now - lastMtcAt <= 500;
  const row = (id: string): Row | undefined => rows.find(entry => entry.id === id);
  const lightingRow = row(`port:${profile?.internalPlayer?.mtcOutputPortProfileId ?? 'internal-mtc-output'}`);
  const lightingStatus: Pick<Row, 'state' | 'value' | 'detail'> = player.state.status === 'playing' && player.state.mtcSending
    ? { state: 'ready', value: '时间码已发出', detail: '正在按音频位置发出灯光时间码；控台有没有收到，请看控台的时间码窗口' }
    : player.state.mtcConnectionFailed && player.state.status === 'playing'
      ? { state: 'error', value: '没发出', detail: '音乐照常播放，但灯光时间码没有发出去' }
      : lightingRow ?? { state: 'skipped', value: '未启用', detail: '当前工程没有设置灯光输出' };
  const audioStatus: Pick<Row, 'state' | 'value' | 'detail'> | undefined = internal && player.state.status === 'playing'
    ? { state: 'ready', value: '播放中', detail: '联动台正在播放音乐' }
    : internal || !project ? row('audio') : row('p1');
  const overview: { name: string; status: Pick<Row, 'state' | 'value' | 'detail'> | undefined; category: SettingsCategory; focus?: SettingsFocus }[] = [
    { name: '音频', status: audioStatus, category: internal || !project ? 'audio' : 'source', ...(internal || !project ? { focus: 'audio-output' as const } : {}) },
    { name: '视频', status: row('obs'), category: 'obs', focus: 'obs-connection' },
    { name: '灯光', status: lightingStatus, ...lightingConnectionDestination },
    { name: '编辑灯光', status: ma2EditingConnectionStatus({ method, network, networkError, local, bridge: checks.bridge }), category: 'ma2', focus: 'ma2-connection' }
  ];
  return <div className="toolbar-project-summary"><button type="button" className="topbar-details-trigger" aria-pressed={open} onClick={() => { setOpen(value => !value); setSelected(null); }}>详细</button>
    {statusHost ? createPortal(open ? <><div className="toolbar-connections" aria-label="全部连接状态" onWheel={event => { event.currentTarget.scrollLeft += event.deltaY; }}>
      {rows.map(row => <button key={row.id} className={'toolbar-connection connection-chip state-' + row.state} aria-label={row.name + '：' + row.value} aria-pressed={selected === row.id} title={`${row.name}：${row.value}\n${row.detail}`} onClick={() => setSelected(selected === row.id ? null : row.id)}>{row.name}</button>)}
      <ToolbarMtcStatus player={player} receiving={receiving} onSettings={() => onSettings('audio')} portStatus={checks.midi?.state === 'error' ? '不可用' : '详见上面各个输入输出接口'} portDetail={targets.filter(target => target.required).map(target => target.name + '：' + (profile?.midiPortProfiles.find(port => port.id === target.id)?.portName ?? '未配置')).join('；')} />
    </div>{detail ? <div className="connection-inline-detail" role="region" aria-label="连接详情"><strong>{detail.name} · {detail.value}</strong><span>{detail.detail}</span><button onClick={() => { onSettings(detail.category); setSelected(null); setOpen(false); }}>前往设置</button><button aria-label="收起连接详情" onClick={() => setSelected(null)}>收起</button></div> : null}</> : <div className="topbar-connection-overview" role="group" aria-label="连接状态概览">{overview.map(entry => <button type="button" key={entry.name} aria-label={`${entry.name}：${entry.status?.value ?? '未检查'}，前往设置`} onClick={() => onSettings(entry.category, entry.focus)} className={`connection-overview-item state-${entry.status?.state ?? 'idle'}`} title={`${entry.name}：${entry.status?.value ?? '未检查'}\n${entry.status?.detail ?? ''}\n点击前往对应设置`}><span className="connection-overview-dot" aria-hidden="true" /><strong>{entry.name}</strong><small>{entry.status?.value ?? '未检查'}</small></button>)}</div>, statusHost) : null}
  </div>;
}
