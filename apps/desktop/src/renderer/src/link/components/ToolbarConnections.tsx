import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ToolbarMtcStatus } from './ToolbarMtcStatus';
import type { ProjectPlayer } from './ProjectPlayerControls';
import type { SettingsCategory, SettingsFocus } from './settings-navigation';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { useStatusCenter } from '../useStatusCenter';

export function ToolbarConnections({ player, statusHost, onSettings }: { player: ProjectPlayer; statusHost: HTMLDivElement | null; onSettings: (category: SettingsCategory, focus?: SettingsFocus) => void }): JSX.Element {
  const { rows, overview, midiTargets: targets } = useStatusCenter(player);
  const project = useDocumentStore(state => state.project);
  const profile = useIntegrationStore(state => state.profile);
  const checks = useConnectionCheckStore(state => state.checks);
  const lastMtcAt = useRuntimeStore(state => state.lastMtcAt);
  const [now, setNow] = useState(() => performance.now());
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const internal = project?.playbackSource === 'internal';
  useEffect(() => {
    if (internal) return;
    const timer = setInterval(() => setNow(performance.now()), 500); return () => clearInterval(timer);
  }, [internal]);
  const detail = rows.find(row => row.id === selected);
  const receiving = lastMtcAt !== null && now >= lastMtcAt && now - lastMtcAt <= 500;
  return <div className="toolbar-project-summary"><button type="button" className="topbar-details-trigger" aria-pressed={open} onClick={() => { setOpen(value => !value); setSelected(null); }}>详细</button>
    {statusHost ? createPortal(open ? <><div className="toolbar-connections" aria-label="全部连接状态" onWheel={event => { event.currentTarget.scrollLeft += event.deltaY; }}>
      {rows.map(row => <button key={row.id} className={'toolbar-connection connection-chip state-' + row.state} aria-label={row.name + '：' + row.value} aria-pressed={selected === row.id} title={`${row.name}：${row.value}\n${row.detail}`} onClick={() => setSelected(selected === row.id ? null : row.id)}>{row.name}</button>)}
      <ToolbarMtcStatus player={player} receiving={receiving} onSettings={() => onSettings('audio')} portStatus={checks.midi?.state === 'error' ? '不可用' : '详见上面各个输入输出接口'} portDetail={targets.filter(target => target.required).map(target => target.name + '：' + (profile?.midiPortProfiles.find(port => port.id === target.id)?.portName ?? '未配置')).join('；')} />
    </div>{detail ? <div className="connection-inline-detail" role="region" aria-label="连接详情"><strong>{detail.name} · {detail.value}</strong><span>{detail.detail}</span><button onClick={() => { onSettings(detail.destination.category); setSelected(null); setOpen(false); }}>前往设置</button><button aria-label="收起连接详情" onClick={() => setSelected(null)}>收起</button></div> : null}</> : <div className="topbar-connection-overview" role="group" aria-label="连接状态概览">{overview.map(entry => <button type="button" key={entry.name} aria-label={`${entry.name}：${entry.status?.value ?? '未检查'}，前往设置`} onClick={() => onSettings(entry.destination.category, entry.destination.focus)} className={`connection-overview-item state-${entry.status?.state ?? 'idle'}`} title={`${entry.name}：${entry.status?.value ?? '未检查'}\n${entry.status?.detail ?? ''}\n点击前往对应设置`}><span className="connection-overview-dot" aria-hidden="true" /><strong>{entry.name}</strong><small>{entry.status?.value ?? '未检查'}</small></button>)}</div>, statusHost) : null}
  </div>;
}
