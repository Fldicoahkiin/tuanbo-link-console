import { useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import { Button } from './Button';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

export function DiagnosticExports(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [includeMa2, setIncludeMa2] = useState(false);
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const run = async (kind: 'package' | 'text' | 'folder'): Promise<void> => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (kind === 'folder') { await desktop.openLogsFolder(); setMessage('已打开本机日志文件夹。'); return; }
      const project = useDocumentStore.getState().project;
      const integration = useIntegrationStore.getState();
      const path = kind === 'text' ? await desktop.exportLogs({ days }) : await desktop.exportDiagnosticPackage({
        problem: note.trim(),
        project: project ? { projectId: project.projectId, name: project.name, schemaVersion: project.schemaVersion,
          playbackSource: project.playbackSource, programs: project.rundown.length, assets: project.mediaAssets?.length ?? 0 } : null,
        connections: { obs: integration.obs, midiPorts: integration.midiPorts },
        profile: integration.profile ? { acceptedVersions: integration.profile.acceptedVersions,
          internalPlayer: integration.profile.internalPlayer, midiPortProfiles: integration.profile.midiPortProfiles } : null,
        ...(includeMa2 && project?.ma2ReadState ? { ma2ReadState: project.ma2ReadState } : {})
      }, { days });
      setMessage(path ? `已导出：${path}` : '已取消导出。');
    } catch (failure) { setError(`操作失败：${failure instanceof Error ? failure.message : String(failure)}`); }
    finally { setBusy(false); }
  };
  return <section className="diagnostic-exports" aria-label="导出日志与诊断">
    <details className="diagnostic-export-options">
    <summary>附加问题说明与灯光数据（选填）</summary>
    <div className="diagnostic-export-fields">
    <p className="settings-note">诊断包包含软件版本、电脑信息、连接状态和日志，发回此文件即可排查。密码会隐藏，不包含音视频素材。</p>
    <label className="settings-field">问题描述（选填）<textarea rows={2} maxLength={2000} value={note} onChange={event => setNote(event.currentTarget.value)} placeholder="例如：22:10 点击播放后没有出灯，重开后仍能复现" /></label>
    <label><input type="checkbox" checked={includeMa2} onChange={event => setIncludeMa2(event.currentTarget.checked)} /> 包含当前工程已读取的 MA2 原始数据（排查 Cue、配对和转换问题）</label>
    </div></details>
    <label className="settings-row"><span>导出范围</span><select aria-label="导出范围" value={days} disabled={busy} onChange={event => setDays(event.currentTarget.value === '1' ? 1 : event.currentTarget.value === '30' ? 30 : 7)}><option value="1">最近 1 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天（全部保留的日志）</option></select></label>
    <div className="device-panel-actions">
      <Button className="primary-button" disabled={busy} onClick={() => void run('package')}><Download />{busy ? '正在处理…' : '导出诊断包'}</Button>
      <Button className="secondary-button" disabled={busy} onClick={() => void run('text')}><Download />导出日志</Button>
      <Button className="secondary-button" disabled={busy} onClick={() => void run('folder')}><FolderOpen />打开日志文件夹</Button>
    </div>
    <p className="settings-note">发回排查用“导出诊断包”；自己查看用“导出日志”。</p>
    {message ? <p className="settings-note diagnostic-export-result" role="status">{message}</p> : null}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </section>;
}
