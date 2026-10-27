import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useIntegrationStore } from '../stores/integration-store';
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
  return <section className="settings-section" aria-label="本机控台程序">
    <div className="device-section-heading"><h3>本机控台与预演</h3></div>
    <p className="settings-note">一键连接会打开选好的 onPC 和 MA 3D，已经在运行的会直接使用。程序是否运行、控台通信和 MIDI 输出会分别检查。装了多个版本时，请选择配套的版本。</p>
    {(['ma2', 'ma3d'] as const).map(id => {
      const title = id === 'ma2' ? 'MA2 onPC' : 'MA 3D';
      const settings = profile?.[id];
      const process = processes[id];
      return <div key={id} className="device-process-fields">
        <label className="settings-row"><span>{title}</span><div className="device-path-control">
          <input aria-label={`${title} 程序位置`} readOnly value={settings?.executablePath ?? ''} placeholder="一键识别或选择已安装的程序" />
          <button disabled={disabled || busy} onClick={() => void update(id)} aria-label={`选择 ${title} 程序`}><FolderOpen />浏览</button>
        </div></label>
        <label className="settings-row"><span>一键启动 {title}</span><input type="checkbox" role="switch" checked={settings?.connectOnDemand ?? false} disabled={disabled || busy || !settings} onChange={event => void update(id, event.target.checked)} /></label>
        <p className="settings-note">{process.status === 'running' ? `${title} 已运行` : process.error ?? `${title} 未运行`}</p>
      </div>;
    })}
  </section>;
}
