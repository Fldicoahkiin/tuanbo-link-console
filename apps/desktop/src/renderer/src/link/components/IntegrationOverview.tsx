import { CircleStop, Play } from 'lucide-react';
import { Button, Card, Disclosure, Notice, StatusBadge } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
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
  const ready: ConnectionStatus = { state: readyCount === 3 ? 'ready' : 'warning', value: `${readyCount} / 3 项就绪`, detail: 'OBS、P1 和 MTC 时间码' };
  return <Card title="跟随 P1 播放" description={currentItemTitle ? `当前节目：${currentItemTitle}` : '还没设置当前节目，请先到节目单里选一首。'} actions={<StatusBadge name="跟随 P1" status={ready} />}>
    {!securityAvailable ? <Notice tone="warning">Windows 安全存储用不了，暂时存不了 OBS 密码，也连不上 OBS。</Notice> : null}
    <div className="settings-actions-row">
      {runtimeActive
        ? <Button variant="danger" icon={CircleStop} aria-label="停止联动" disabled={runtimeState === 'stopping'} onClick={onStop}>停止联动</Button>
        : <Button variant="primary" icon={Play} aria-label="启动设备并准备跟随 P1" disabled={busy || !securityAvailable || !coordinatorAvailable || !currentItemTitle} onClick={onLaunch}
          title={!coordinatorAvailable ? '请先新建或打开工程' : !currentItemTitle ? '请先在节目单里设置当前节目' : undefined}>启动并待命</Button>}
    </div>
  </Card>;
}

export function IntegrationFooter({ midiPorts, inventory }: {
  midiPorts: ReturnType<LinkMidiAdapter['listPorts']>;
  inventory: LinkObsInventory | null;
}): JSX.Element {
  return <Disclosure title="电脑检测到了哪些设备？" description={`${midiPorts.length} 个 MIDI 接口 · OBS ${inventory ? '已读取' : '还没读取'}`}>
    <section className="settings-subsection" aria-label="Windows MIDI 接口">
      <header className="settings-subsection-header"><h3>Windows MIDI 接口</h3><span>{midiPorts.length} 个</span></header>
      <p>这里只显示检测结果。选播放设备或时间码接口，请到“音频与 MIDI”。</p>
      {midiPorts.length > 0 ? <ul className="settings-list">{midiPorts.map((port) => <li key={`${port.direction}-${port.id}`}>{port.direction === 'input' ? '接收' : '发送'} · {port.name}{port.state === 'connected' ? '' : '（不可用）'}</li>)}</ul>
        : <p>没检测到 MIDI 接口，请检查设备是否接好。</p>}
    </section>
    <section className="settings-subsection" aria-label="从 OBS 读取的内容">
      <header className="settings-subsection-header"><h3>从 OBS 读取的内容</h3></header>
      {inventory ? <dl className="settings-facts"><dt>场景</dt><dd>{inventory.scenes.length}</dd><dt>来源</dt><dd>{inventory.inputs.length}</dd><dt>滤镜</dt><dd>{Object.values(inventory.filters).flat().length}</dd><dt>转场</dt><dd>{inventory.transitions.length}</dd></dl>
        : <p>还没读取。请先到“OBS Studio”连接，再重新检测。</p>}
    </section>
  </Disclosure>;
}
