import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { toUserErrorMessage } from '@tb/core/link';
import { ma2NetworkStatusSchema, loopMidiStatusSchema, type Ma2NetworkStatus } from '@tb/schema';
import { ToolbarMtcStatus } from './ToolbarMtcStatus';
import type { ProjectPlayer } from './ProjectPlayerControls';
import type { SettingsCategory } from './settings-navigation';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useLocalMa2Store } from '../stores/ma2-connection-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useConnectionCheckStore, type ConnectionCheck } from '../stores/connection-check-store';
import { midiConnectionTargets } from '../view-models/connection-targets';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

type Row = { id: string; name: string; value: string; state: 'ready' | 'error' | 'checking' | 'idle' | 'skipped'; detail: string; category: SettingsCategory };
const statusLabel = { checking: '连接中', ready: '已就绪', error: '待处理', skipped: '未启用' };
function checked(row: Row, check: ConnectionCheck | undefined): Row {
  return check ? { ...row, state: check.state, value: statusLabel[check.state], detail: check.detail } : row;
}

export function ToolbarConnections({ player, statusHost, onSettings }: { player: ProjectPlayer; statusHost: HTMLDivElement | null; onSettings: (category: SettingsCategory) => void }): JSX.Element {
  const method = useMa2ModeStore(state => state.method);
  const local = useLocalMa2Store();
  const project = useDocumentStore(state => state.project);
  const obs = useIntegrationStore(state => state.obs);
  const p1 = useIntegrationStore(state => state.processes.p1);
  const profile = useIntegrationStore(state => state.profile);
  const ports = useIntegrationStore(state => state.midiPorts);
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
      try { const status = ma2NetworkStatusSchema.parse(await desktop.getMa2NetworkStatus()); if (alive) { setNetwork(status); setNetworkError(null); timer = setTimeout(() => void read(), 3000); } }
      catch (error) { if (alive) setNetworkError(toUserErrorMessage(error)); }
    };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, [method, running]);
  useEffect(() => {
    let alive = true;
    const inspectAudio = async (): Promise<void> => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!alive || useConnectionCheckStore.getState().running) return;
        const device = devices.find(entry => entry.kind === 'audiooutput' && entry.deviceId === (profile?.internalPlayer?.audioOutputDeviceId ?? 'default'));
        useConnectionCheckStore.getState().finish('audio', device ? 'ready' : 'error', device ? '音频设备可用，播放时启用正式输出' : '所选音频设备不可用，请重新选择输出线路');
      } catch (error) { if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('audio', 'error', toUserErrorMessage(error)); }
    };
    const onAudioChange = (): void => { void inspectAudio(); };
    onAudioChange(); navigator.mediaDevices.addEventListener('devicechange', onAudioChange);
    return () => { alive = false; navigator.mediaDevices.removeEventListener('devicechange', onAudioChange); };
  }, [profile?.internalPlayer?.audioOutputDeviceId]);
  useEffect(() => {
    let alive = true;
    void desktop.loopMidi('detect').then(value => {
      const status = loopMidiStatusSchema.parse(value);
      if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('loop', status.state === 'running' ? 'ready' : profile?.loopMidi?.autoStart ? 'error' : 'skipped', status.state === 'running' ? 'loopMIDI 已运行，端口单独检查' : profile?.loopMidi?.autoStart ? '虚拟 MIDI 未启动，点击一键连接' : '未启用虚拟 MIDI 自动启动，实体 MIDI 不依赖此项');
    }).catch(error => { if (alive && !useConnectionCheckStore.getState().running) useConnectionCheckStore.getState().finish('loop', 'error', toUserErrorMessage(error)); });
    return () => { alive = false; };
  }, [profile?.loopMidi?.autoStart]);
  const rows: Row[] = [
    checked({ id: 'obs', name: 'OBS 控制', value: obs.status === 'connected' ? '已连接' : obs.status === 'connecting' || obs.status === 'reconnecting' ? '连接中' : '未连接', state: obs.status === 'connected' ? 'ready' : obs.error ? 'error' : 'idle', detail: obs.error ?? '连接 OBS 场景与动作控制', category: 'obs' }, checks.obs),
    checked({ id: 'preview', name: 'OBS 预览', value: obs.status === 'connected' ? '未检查' : '待 OBS 连接', state: 'idle', detail: '一键连接会检查内置组件并接收真实预览画面', category: 'obs' }, obs.status === 'connected' ? checks.preview : undefined),
    checked({ id: 'audio', name: '音频输出', value: '检测中', state: 'idle', detail: '检查选择的声音输出设备', category: 'audio' }, checks.audio),
    checked({ id: 'midi', name: '系统 MIDI', value: '检测中', state: 'idle', detail: '检查系统 MIDI 服务与驱动', category: 'audio' }, checks.midi),
    checked({ id: 'loop', name: '虚拟 MIDI', value: '未检查', state: 'idle', detail: '软件间 MIDI 通道；实体接口不依赖此项', category: 'virtual' }, checks.loop),
    checked({ id: 'p1', name: 'P1 播放器', value: internal || !project ? '未启用' : p1.status === 'running' ? '运行中' : '未运行', state: internal || !project ? 'skipped' : p1.status === 'running' ? 'ready' : 'idle', detail: internal ? '当前使用本机播放，无需启动 P1' : p1.error ?? '跟随模式会启动 P1 并监听输入时间码', category: 'source' }, internal || !project ? undefined : checks.p1),
    { id: 'ma2', name: 'MA2 网络', value: method !== 'network' ? '未启用' : network?.state === 'connected' ? '已连接' : checks.ma2?.state === 'checking' ? '连接中' : '未连接', state: method !== 'network' ? 'skipped' : network?.state === 'connected' ? 'ready' : checks.ma2?.state === 'checking' ? 'checking' : networkError || network?.error || checks.ma2?.state === 'error' ? 'error' : 'idle', detail: method !== 'network' ? '当前使用 ' + (method === 'local' ? '本机 onPC' : 'MIDI') : networkError ?? network?.error ?? checks.ma2?.detail ?? '一键连接会连接已保存控台，未保存时识别局域网中的唯一控台', category: 'ma2' },
    checked({ id: 'bridge', name: 'MA2 工程通信', value: method === 'midi' ? '未启用' : method === 'local' && local.status === 'ready' ? '已响应' : method === 'network' && network?.state !== 'connected' ? '待网络连接' : '未检查', state: method === 'midi' ? 'skipped' : method === 'local' && local.status === 'ready' ? 'ready' : 'idle', detail: method === 'midi' ? 'MIDI 模式不提供工程读写连接' : local.error ?? '单独验证控台读写通信，网络登录成功不代表此项已就绪', category: 'ma2' }, method === 'midi' || method === 'network' && network?.state !== 'connected' ? undefined : checks.bridge)
  ];
  for (const [id, name] of [['discovery', '程序识别'], ['profile', '连接配置']] as const) {
    if (checks[id]?.state === 'error') rows.unshift(checked({ id, name, value: '待处理', state: 'error', detail: '', category: 'maintenance' }, checks[id]));
  }
  // A stale successful check never overrides an actual disconnect.
  const obsRow = rows.find(row => row.id === 'obs');
  if (obs.status !== 'connected' && obsRow?.state === 'ready') { obsRow.state = 'idle'; obsRow.value = '未连接'; obsRow.detail = obs.error ?? 'OBS 已断开'; }
  for (const target of targets) {
    const mapped = profile?.midiPortProfiles.find(port => port.id === target.id && port.direction === target.direction);
    const matching = ports.filter(port => port.name === mapped?.portName && port.direction === target.direction && port.state === 'connected');
    const available = matching.length === 1;
    const open = available && matching[0]?.connection === 'open';
    const key = 'port:' + target.id;
    const check = checks[key];
    rows.push({ id: key, name: target.name, state: check?.state === 'checking' ? 'checking' : !target.required ? 'skipped' : open ? 'ready' : check?.state === 'error' || checks.midi?.state === 'error' ? 'error' : 'idle',
      value: check?.state === 'checking' ? '连接中' : !target.required ? '未启用' : open ? '已打开' : !mapped?.portName ? '未配置' : available ? '可用' : '未连接',
      detail: check?.state === 'error' ? check.detail : target.required ? (mapped?.portName ?? '尚未选择接口') + '；接口就绪不代表正在收发时间码或 Cue' : '未启用此接口；在音频与 MIDI 中配置后纳入一键连接', category: 'audio' });
  }
  const detail = rows.find(row => row.id === selected);
  const receiving = lastMtcAt !== null && now >= lastMtcAt && now - lastMtcAt <= 500;
  const row = (id: string): Row | undefined => rows.find(entry => entry.id === id);
  const currentItem = project?.rundown.find(item => item.id === player.state.itemId);
  const lightingPort = targets.find(target => target.required && target.direction === 'output' && /灯光|Cue/.test(target.name));
  const lightingRow = currentItem?.lighting?.outputMode === 'timecode' && lightingPort ? row(`port:${lightingPort.id}`)
    : method === 'network' ? row('ma2') : lightingPort ? row(`port:${lightingPort.id}`) : row('ma2');
  const lightingStatus: Pick<Row, 'state' | 'value' | 'detail'> = player.state.status === 'playing' && player.state.mtcSentPositionMs !== null
    ? { state: 'ready', value: '发送中', detail: '正在按音频位置输出灯光时间码' }
    : player.state.mtcConnectionFailed && player.state.status === 'playing'
      ? { state: 'error', value: '未连接', detail: '本次音频继续播放，灯光时间码未输出' }
      : lightingRow ?? { state: 'skipped', value: '未启用', detail: '当前工程未配置灯光输出' };
  const audioStatus: Pick<Row, 'state' | 'value' | 'detail'> | undefined = internal && player.state.status === 'playing'
    ? { state: 'ready', value: '播放中', detail: '本机音频正在播放' }
    : internal || !project ? row('audio') : row('p1');
  const overview = [
    { name: '音频', status: audioStatus },
    { name: '视频', status: row('obs') },
    { name: '灯光', status: lightingStatus },
    { name: '编辑灯光', status: row('bridge') }
  ];
  return <div className="toolbar-project-summary"><button type="button" className="topbar-details-trigger" aria-pressed={open} onClick={() => { setOpen(value => !value); setSelected(null); }}>详细</button>
    {statusHost ? createPortal(open ? <><div className="toolbar-connections" aria-label="全部连接状态">
      {rows.map(row => <button key={row.id} className={'toolbar-connection connection-chip state-' + row.state} aria-label={row.name + '：' + row.value} aria-pressed={selected === row.id} title={`${row.name}：${row.value}\n${row.detail}`} onClick={() => setSelected(selected === row.id ? null : row.id)}>{row.name}</button>)}
      <ToolbarMtcStatus player={player} receiving={receiving} onSettings={() => onSettings('audio')} portStatus={checks.midi?.state === 'error' ? '不可用' : '详见上方各输入输出接口'} portDetail={targets.filter(target => target.required).map(target => target.name + '：' + (profile?.midiPortProfiles.find(port => port.id === target.id)?.portName ?? '未配置')).join('；')} />
    </div>{detail ? <div className="connection-inline-detail" role="region" aria-label="连接详情"><strong>{detail.name} · {detail.value}</strong><span>{detail.detail}</span><button onClick={() => { onSettings(detail.category); setSelected(null); setOpen(false); }}>前往设置</button><button aria-label="收起连接详情" onClick={() => setSelected(null)}>收起</button></div> : null}</> : <div className="topbar-connection-overview" role="group" aria-label="连接状态概览">{overview.map(entry => <span key={entry.name} className={`connection-overview-item state-${entry.status?.state ?? 'idle'}`} title={`${entry.name}：${entry.status?.value ?? '未检查'}\n${entry.status?.detail ?? ''}`}><span className="connection-overview-dot" aria-hidden="true" /><strong>{entry.name}</strong><small>{entry.status?.value ?? '未检查'}</small></span>)}</div>, statusHost) : null}
  </div>;
}
