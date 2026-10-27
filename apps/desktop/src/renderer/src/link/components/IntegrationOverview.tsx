import { Cable, ChevronDown, CircleStop, MonitorUp, Play, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { LinkObsInventory } from '@tb/core/link';
import type { LinkMidiAdapter } from '../../registry/link-midi-adapter';

export function IntegrationHero({ busy, securityAvailable, coordinatorAvailable, currentItemTitle, runtimeState, obsReady, p1Ready, mtcReady, onLaunch, onStop }: {
  busy: boolean;
  securityAvailable: boolean;
  coordinatorAvailable: boolean;
  currentItemTitle: string | null;
  runtimeState: string;
  obsReady: boolean;
  p1Ready: boolean;
  mtcReady: boolean;
  onLaunch: () => void;
  onStop: () => void;
}): JSX.Element {
  const readyCount = [obsReady, p1Ready, mtcReady].filter(Boolean).length;
  const runtimeActive = runtimeState !== 'idle';
  return <header className="integration-hero">
    <div className="integration-toolbar-title">
      <span className={`integration-current-item ${currentItemTitle ? 'ready' : 'missing'}`} title={currentItemTitle ?? '请先在工程与节目单中设置当前节目'}>{currentItemTitle ? `当前节目：${currentItemTitle}` : '未设置当前节目'}</span>
      <span className={`integration-security-state ${securityAvailable ? 'ok' : 'error'}`}><ShieldCheck />Windows 安全存储</span>
      <span className="integration-ready-count">{readyCount} / 3 项就绪</span>
    </div>
    <div className="integration-hero-actions">
      {runtimeActive
        ? <button className="integration-stop-button" aria-label="停止联动" disabled={runtimeState === 'stopping'} onClick={onStop}><CircleStop />停止联动</button>
        : <button className="integration-launch-button" aria-label="启动设备并准备跟随 P1" disabled={busy || !securityAvailable || !coordinatorAvailable || !currentItemTitle} onClick={onLaunch} title={!coordinatorAvailable ? '请先新建或打开工程' : !currentItemTitle ? '请先在工程与节目单中设置当前节目' : undefined}><Play />启动并待命</button>}
    </div>
  </header>;
}

export function IntegrationFooter({ midiPorts, inventory }: {
  midiPorts: ReturnType<LinkMidiAdapter['listPorts']>;
  inventory: LinkObsInventory | null;
}): JSX.Element {
  return <details className="integration-diagnostics device-advanced">
    <summary><span><SlidersHorizontal />电脑检测到了哪些设备？</span><small>{midiPorts.length} 个 MIDI 端口 · OBS {inventory ? '已读取' : '还没读取'}</small><ChevronDown /></summary>
    <div className="integration-resources">
      <section className="midi-inventory">
        <div className="panel-title"><span><Cable />Windows MIDI 端口</span><small>{midiPorts.length}</small></div>
        <p className="settings-note">这里只显示检测结果。选择播放设备或时间码端口，请到“音频与 MIDI”。</p>
        <div className="chip-list">{midiPorts.length > 0 ? midiPorts.map((port) => <span className={port.state === 'connected' ? 'chip ok' : 'chip error'} key={`${port.direction}-${port.id}`}>{port.direction === 'input' ? '接收' : '发送'} · {port.name}</span>) : <p className="inventory-empty">未检测到 MIDI 端口，请检查设备是否接入。</p>}</div>
      </section>
      <section className="inventory-summary">
        <div className="panel-title"><span><MonitorUp />从 OBS 读取的内容</span></div>
        {inventory
          ? <div className="stat-strip"><span><strong>{inventory.scenes.length}</strong>场景</span><span><strong>{inventory.inputs.length}</strong>来源</span><span><strong>{Object.values(inventory.filters).flat().length}</strong>滤镜</span><span><strong>{inventory.transitions.length}</strong>转场</span></div>
          : <p className="inventory-empty">还没读取，请先到“OBS Studio”连接，再重新检测。</p>}
      </section>
    </div>
  </details>;
}
