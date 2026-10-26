import { useState } from 'react';
import { ModalSurface } from './ModalSurface';
import { MtcOutputStatus } from './MtcOutputStatus';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';

export function ToolbarMtcStatus({ player, receiving, portStatus, portDetail, onSettings }: {
  player: ProjectPlayer; receiving: boolean; portStatus: string; portDetail: string; onSettings: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const project = useDocumentStore(state => state.project);
  const currentId = useRuntimeStore(state => state.currentItemId);
  const internal = project?.playbackSource === 'internal';
  const item = project?.rundown.find(entry => entry.id === (player.state.itemId ?? currentId));
  const sending = internal && player.state.status === 'playing' && player.state.mtcSending;
  const status = internal ? sending ? '发送中' : '待发送' : receiving ? '接收中' : '无信号';
  const active = sending || !internal && receiving;
  return <>
    <button className={`toolbar-connection toolbar-mtc-button state-${active ? 'ready' : 'idle'}`} aria-label={`MTC 状态：${status}`} aria-haspopup="dialog" aria-expanded={open} title={`MTC ${status} · 接口${portStatus}；点击查看与设置`} onClick={() => setOpen(true)}>MTC 信号</button>
    {open ? <ModalSurface className="modal-card" label="MTC 时间码状态" onClose={() => setOpen(false)}>
      <h2>MTC 时间码</h2><p>接口：{portStatus}</p>{portDetail ? <p className="mtc-port-detail">{portDetail}</p> : null}
      {internal && item && project ? <MtcOutputStatus player={player} item={item} frameRate={project.timebase.frameRate} /> : <><p>{internal ? '播放后显示时间码发送状态。' : receiving ? '正在接收外部时间码。' : '还没收到外部时间码。'}</p></>}
      <div className="modal-actions"><button className="secondary-button" onClick={() => setOpen(false)}>关闭</button><button className="primary-button" onClick={() => { setOpen(false); onSettings(); }}>音频与 MIDI 设置</button></div>
    </ModalSurface> : null}
  </>;
}
