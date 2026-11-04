import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useIntegrationStore } from '../stores/integration-store';
import { Button, Card, Field, Notice, StatusBadge, Switch, TextInput } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

export function Ma2ProgramSettings({ disabled, notify }: {
  disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  const profile = useIntegrationStore(state => state.profile);
  const processes = useIntegrationStore(state => state.processes);
  const [busy, setBusy] = useState(false);
  const update = async (id: 'ma2' | 'ma3d', enabled?: boolean): Promise<void> => {
    setBusy(true);
    try {
      const path = enabled === undefined ? await desktop.pickExecutable() : undefined;
      if (enabled === undefined && !path) return;
      const current = useIntegrationStore.getState().profile;
      if (!current) throw new Error('请先保存本机连接配置');
      const previous = current[id];
      const settings = path ? {
        arguments: [], startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000, ...previous,
        executablePath: path, workingDirectory: path.replace(/[\\/][^\\/]+$/, ''), connectOnDemand: true
      } : previous ? { ...previous, connectOnDemand: enabled ?? previous.connectOnDemand } : undefined;
      if (!settings) throw new Error('请先选择程序位置');
      const next = { ...current, [id]: settings, updatedAt: new Date().toISOString() };
      await desktop.saveIntegrationProfile({ profile: next });
      useIntegrationStore.getState().setProfile(next);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  return <section className="settings-stack" aria-label="本机控台程序">
    <p className="settings-lead">一键连接会打开选好的 onPC 和 MA 3D，已经在运行的直接用。程序是否运行、控台通信和 MIDI 输出分别检查。装了多个版本时，选配套的那个。</p>
    {(['ma2', 'ma3d'] as const).map(id => {
      const title = id === 'ma2' ? 'MA2 onPC' : 'MA 3D';
      const settings = profile?.[id];
      const process = processes[id];
      const running: ConnectionStatus = process.status === 'running' ? { state: 'ready', value: '已运行', detail: `${title} 正在运行` }
        : process.error ? { state: 'error', value: '出错', detail: process.error } : { state: 'idle', value: '未运行', detail: `${title} 没有运行` };
      return <Card key={id} level={3} title={title} actions={<StatusBadge name={title} status={running} />}>
        <Field label="程序位置">{props => <div className="settings-path-control">
          <TextInput {...props} aria-label={`${title} 程序位置`} readOnly value={settings?.executablePath ?? ''} placeholder="一键识别或选择已安装的程序" />
          <Button variant="secondary" icon={FolderOpen} disabled={disabled || busy} onClick={() => void update(id)} aria-label={`选择 ${title} 程序`}>浏览</Button>
        </div>}</Field>
        <Switch label={`一键启动 ${title}`} help={settings ? '一键连接时顺便打开它' : '先选好程序位置'} checked={settings?.connectOnDemand ?? false} disabled={disabled || busy || !settings} onChange={event => void update(id, event.target.checked)} />
        {process.error ? <Notice tone="error">{process.error}</Notice> : null}
      </Card>;
    })}
  </section>;
}
