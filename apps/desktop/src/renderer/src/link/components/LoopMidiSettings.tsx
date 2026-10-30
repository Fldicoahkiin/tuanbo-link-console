import { Button, Card, Disclosure, Notice, StatusBadge, Switch } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
import { useEffect, useState } from 'react';
import { Download, Play, RefreshCw } from 'lucide-react';
import { loopMidiStatusSchema, type LoopMidiStatus } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { useIntegrationStore } from '../stores/integration-store';

export function LoopMidiSettings({ disabled, notify, onBusy, onRefreshMidi }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (value: boolean) => void; onRefreshMidi: () => Promise<void> }): JSX.Element {
  const profile = useIntegrationStore((state) => state.profile);
  const ports = useIntegrationStore((state) => state.midiPorts);
  const [status, setStatus] = useState<LoopMidiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const configuredPorts = [...new Map((profile?.midiPortProfiles ?? []).filter((port) => port.portName !== '').map((port) => [`${port.direction}:${port.portName}`, port])).values()];
  useEffect(() => {
    let active = true;
    const detect = async (): Promise<void> => {
      try {
        const value = await linkDesktopViewModel.loopMidi('detect');
        if (active) setStatus(loopMidiStatusSchema.parse(value));
      } catch (reason) {
        if (active) setError(`loopMIDI 检测失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    };
    void detect();
    return () => { active = false; };
  }, []);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); onBusy(true); setError(null);
    try { await operation(); } catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); notify(message, 'error'); }
    finally { setBusy(false); onBusy(false); }
  };
  const act = (action: 'detect' | 'start' | 'download'): void => {
    void run(async () => {
      const next = loopMidiStatusSchema.parse(await linkDesktopViewModel.loopMidi(action));
      setStatus(next);
      await onRefreshMidi();
      if (action === 'start') notify(next.state === 'running' ? 'loopMIDI 已运行，请检查 MIDI 端口并选择对应设备。' : '未找到 loopMIDI，请先打开官网安装。', next.state === 'running' ? 'info' : 'error');
    });
  };
  const saveAutoStart = (autoStart: boolean): void => {
    void run(async () => {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const next = { ...current, loopMidi: { autoStart }, updatedAt: new Date().toISOString() };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next });
      useIntegrationStore.getState().setProfile(next);
      notify(autoStart ? '已开启随联动台启动，下次打开联动台或一键连接时会自动启动 loopMIDI。' : '已关闭随联动台启动。');
    });
  };
  const running = status?.state === 'running';
  const connectedCount = ports.filter((port) => port.state === 'connected').length;
  const badge: ConnectionStatus = !status ? { state: 'checking', value: '正在检测…', detail: '正在找这台电脑上的 loopMIDI' }
    : status.state === 'running' ? { state: 'ready', value: '正在运行', detail: 'loopMIDI 已经在运行' }
    : status.state === 'installed' ? { state: 'warning', value: '已安装 · 未运行', detail: '点“启动 loopMIDI”打开它' }
    : { state: 'idle', value: '未找到安装', detail: '点“打开官网安装”下载 loopMIDI' };
  return <>
    <Card title="loopMIDI" description="在同一台电脑上连接 P1、联动台和 MA2 onPC 的虚拟 MIDI 接口。" actions={<StatusBadge name="loopMIDI" status={badge} />}>
      <div className="settings-actions-row">
        <Button variant={status?.state === 'installed' ? 'primary' : 'secondary'} icon={Play} loading={busy} disabled={disabled || busy || !status || status.state === 'missing' || running} onClick={() => act('start')}>{busy ? '正在处理…' : running ? '已在运行' : '启动 loopMIDI'}</Button>
        <Button variant="secondary" icon={RefreshCw} disabled={disabled || busy} onClick={() => act('detect')}>重新检测</Button>
        <Button variant={status?.state === 'missing' ? 'primary' : 'secondary'} icon={Download} disabled={disabled || busy} onClick={() => act('download')}>打开官网安装</Button>
      </div>
      <Switch label="随联动台启动" aria-label="随联动台启动 loopMIDI" help="打开联动台或一键连接时自动启动 loopMIDI" checked={profile?.loopMidi?.autoStart ?? false} disabled={disabled || busy} onChange={(event) => saveAutoStart(event.currentTarget.checked)} />
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Card>
    <Card title="已配置的通道" description={`系统识别到 ${connectedCount} 个输入／输出接口。接口可用不代表已经收到时间码。`}>
      {configuredPorts.length ? <table className="settings-table">
        <thead><tr><th scope="col">接口名称</th><th scope="col">方向</th><th scope="col">状态</th></tr></thead>
        <tbody>{configuredPorts.map((port) => <tr key={port.id}><td>{port.portName}</td><td>{port.direction === 'input' ? '输入' : '输出'}</td><td>{ports.filter((entry) => entry.name === port.portName && entry.direction === port.direction && entry.state === 'connected').length === 1 ? '可用' : '缺失或重名'}</td></tr>)}</tbody>
      </table> : <p>还没选接口，到“音频与 MIDI”设置输入和输出。</p>}
    </Card>
    <Disclosure title="首次安装与接口配置">
      <ol className="settings-list">
        <li>打开官网安装 loopMIDI，然后启动程序。</li>
        <li>输入接口名称，点“＋”创建。P1 和联动台选同一个接口，MA2 onPC 建议单独用一个。</li>
        <li>回到联动台重新检测，再到“音频与 MIDI”选设备。</li>
      </ol>
      <p>只用联动台放音乐和控制 OBS 时不需要安装。退出联动台时 loopMIDI 会继续运行。装在自定义位置没被认出来的话，先手动启动它，再重新检测。</p>
    </Disclosure>
  </>;
}
