import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import type { SettingsCategory, SettingsFocus } from './settings-navigation';
import { MtcOutputStatus } from './MtcOutputStatus';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { useStatusCenter } from '../useStatusCenter';
import { statusGroups, type StatusRow } from '../view-models/status-center';
import { Button, Dialog, Popover, StatusBadge } from '../ui';

type OpenSettings = (category: SettingsCategory, focus?: SettingsFocus) => void;
type Mtc = { status: string; active: boolean; portStatus: string; portDetail: string };

/**
 * The connection status on the title bar (2026-10-30 rework): the four overview chips stay in view;
 * 详细 opens every connection grouped by device under the button. A row opens its explanation and
 * the way to its settings; the MTC row opens the timecode window.
 */
export function TitlebarStatus({ player, onSettings }: { player: ProjectPlayer; onSettings: OpenSettings }): JSX.Element {
  const { rows, overview, midiTargets } = useStatusCenter(player);
  const profile = useIntegrationStore(state => state.profile);
  const checks = useConnectionCheckStore(state => state.checks);
  const [open, setOpen] = useState(false);
  const [mtcOpen, setMtcOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const mtc = useMtcStatus(player, open || mtcOpen);
  const portStatus = checks.midi?.state === 'error' ? '不可用' : '详见上面各个输入输出接口';
  const portDetail = midiTargets.filter(target => target.required).map(target => target.name + '：' + (profile?.midiPortProfiles.find(port => port.id === target.id)?.portName ?? '未配置')).join('；');
  return <div className="titlebar-status">
    <div className="titlebar-overview" role="group" aria-label="连接状态概览">{overview.map(entry => {
      const status = entry.status ?? { state: 'idle' as const, value: '未检查', detail: '' };
      return <StatusBadge key={entry.name} name={entry.name} status={status} showName label={`${entry.name}：${status.value}，前往设置`}
        title={`${entry.name}：${status.value}\n${status.detail}\n点击前往对应设置`} onOpen={() => onSettings(entry.destination.category, entry.destination.focus)} />;
    })}</div>
    <Button ref={setTrigger} variant="ghost" className="titlebar-details" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)}>详细<ChevronDown aria-hidden="true" /></Button>
    {open ? <Popover anchor={trigger} label="全部连接状态" className="status-panel" onClose={close}>
      <StatusPanel rows={rows} mtc={{ ...mtc, portStatus, portDetail }} onSettings={(category) => { close(); onSettings(category); }} onMtc={() => { close(); setMtcOpen(true); }} />
    </Popover> : null}
    {mtcOpen ? <MtcStatusDialog player={player} mtc={{ ...mtc, portStatus, portDetail }} onClose={() => setMtcOpen(false)} onSettings={() => { setMtcOpen(false); onSettings('audio'); }} /> : null}
  </div>;
}

function StatusPanel({ rows, mtc, onSettings, onMtc }: { rows: StatusRow[]; mtc: Mtc; onSettings: (category: SettingsCategory) => void; onMtc: () => void }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const problems = rows.filter(row => row.state === 'error').length;
  return <>
    <header className="status-panel-heading"><h2>连接状态</h2><span data-state={problems ? 'error' : 'ready'}>{problems ? `${problems} 项要处理` : '没有要处理的项'}</span></header>
    {statusGroups(rows).map(group => <section key={group.id} className="status-panel-group" aria-label={group.name}>
      <h3>{group.name}</h3>
      <ul>
        {group.rows.map(row => <li key={row.id}>
          <Button variant="ghost" className="status-panel-row" data-state={row.state} aria-label={`${row.name}：${row.value}`} aria-expanded={selected === row.id}
            title={`${row.name}：${row.value}\n${row.detail}`} onClick={() => setSelected(selected === row.id ? null : row.id)}>
            <span className="status-panel-dot" aria-hidden="true" /><span className="status-panel-name">{row.name}</span><span className="status-panel-value">{row.value}</span><ChevronRight aria-hidden="true" />
          </Button>
          {selected === row.id ? <div className="status-panel-detail" role="region" aria-label="连接详情">
            <p>{row.detail || '没有更多说明。'}</p>
            <div><Button variant="ghost" size="sm" aria-label="收起连接详情" onClick={() => setSelected(null)}>收起</Button><Button variant="secondary" size="sm" onClick={() => onSettings(row.destination.category)}>前往设置</Button></div>
          </div> : null}
        </li>)}
        {group.id === 'audio' ? <li>
          <Button variant="ghost" className="status-panel-row" data-state={mtc.active ? 'ready' : 'idle'} aria-label={`MTC 状态：${mtc.status}`} aria-haspopup="dialog" title={`MTC ${mtc.status} · 接口${mtc.portStatus}；点击查看与设置`} onClick={onMtc}>
            <span className="status-panel-dot" aria-hidden="true" /><span className="status-panel-name">MTC 时间码</span><span className="status-panel-value">{mtc.status}</span><ChevronRight aria-hidden="true" />
          </Button>
        </li> : null}
      </ul>
    </section>)}
  </>;
}

/** Whether timecode goes out (联动台 plays) or comes in (following P1); the input is read twice a second while shown. */
function useMtcStatus(player: ProjectPlayer, shown: boolean): Omit<Mtc, 'portStatus' | 'portDetail'> {
  const project = useDocumentStore(state => state.project);
  const lastMtcAt = useRuntimeStore(state => state.lastMtcAt);
  const [now, setNow] = useState(() => performance.now());
  const internal = project?.playbackSource === 'internal';
  useEffect(() => {
    if (internal || !shown) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(timer);
  }, [internal, shown]);
  const receiving = lastMtcAt !== null && now >= lastMtcAt && now - lastMtcAt <= 500;
  const sending = internal && player.state.status === 'playing' && player.state.mtcSending;
  return { status: internal ? sending ? '发送中' : '待发送' : receiving ? '接收中' : '无信号', active: sending || !internal && receiving };
}

function MtcStatusDialog({ player, mtc, onClose, onSettings }: { player: ProjectPlayer; mtc: Mtc; onClose: () => void; onSettings: () => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const currentId = useRuntimeStore(state => state.currentItemId);
  const internal = project?.playbackSource === 'internal';
  const item = project?.rundown.find(entry => entry.id === (player.state.itemId ?? currentId));
  return <Dialog title="MTC 时间码状态" size="sm" onClose={onClose} actions={<Button variant="primary" onClick={onSettings}>音频与 MIDI 设置</Button>}>
    <p>接口：{mtc.portStatus}</p>
    {mtc.portDetail ? <p className="mtc-port-detail">{mtc.portDetail}</p> : null}
    {internal && item && project ? <MtcOutputStatus player={player} item={item} frameRate={project.timebase.frameRate} />
      : <p>{internal ? '播放后显示时间码发送状态。' : mtc.status === '接收中' ? '正在接收外部时间码。' : '还没收到外部时间码。'}</p>}
  </Dialog>;
}
