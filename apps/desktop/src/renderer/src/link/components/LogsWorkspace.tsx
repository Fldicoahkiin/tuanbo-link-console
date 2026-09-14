import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileSearch, RefreshCw, X } from 'lucide-react';
import type { LinkLogEntryDto } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Props = { notify: (message: string, tone?: 'info' | 'error') => void };

export function LogsWorkspace({ notify }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const profile = useIntegrationStore((state) => state.profile);
  const [entries, setEntries] = useState<LinkLogEntryDto[]>([]);
  const [catalog, setCatalog] = useState<LinkLogEntryDto[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [itemId, setItemId] = useState('');
  const [cueId, setCueId] = useState('');
  const [device, setDevice] = useState('');
  const [result, setResult] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [allEntries, filteredEntries] = await Promise.all([
        linkDesktopViewModel.queryLogs(),
        linkDesktopViewModel.queryLogs({
        ...(sessionId ? { sessionId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(cueId ? { cueId } : {}),
        ...(device ? { device } : {}),
        ...(result ? { result: result as LinkLogEntryDto['result'] } : {})
        })
      ]);
      setCatalog(allEntries);
      setEntries(filteredEntries);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }, [cueId, device, itemId, notify, result, sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const exportPackage = async (): Promise<void> => {
    try {
      const path = await linkDesktopViewModel.exportDiagnosticPackage({
        project: project ? { projectId: project.projectId, name: project.name, schemaVersion: project.schemaVersion } : null,
        profile: profile ? { profileId: profile.profileId, name: profile.name, acceptedVersions: profile.acceptedVersions } : null
      });
      if (path) notify(`脱敏诊断包已导出：${path}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return <div className="page-stack">
    <header className="page-heading"><div><span className="eyebrow">RUN LOG</span><h2>运行日志</h2><p>按会话、节目、Cue、设备和执行结果定位现场问题。</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => void refresh()}><RefreshCw />刷新</button><button className="primary-button" onClick={() => void exportPackage()}><Download />导出脱敏诊断包</button></div></header>
    <section className="log-filters panel">
      <LogFilter label="会话" value={sessionId} values={unique(catalog.map((entry) => entry.sessionId))} onChange={setSessionId} format={(value) => value.slice(0, 8)} />
      <LogFilter label="节目" value={itemId} values={unique(catalog.flatMap((entry) => entry.itemId ? [entry.itemId] : []))} onChange={setItemId} format={(value) => project?.rundown.find((item) => item.id === value)?.title ?? value} />
      <LogFilter label="Cue" value={cueId} values={unique(catalog.flatMap((entry) => entry.cueId ? [entry.cueId] : []))} onChange={setCueId} />
      <label>设备<select value={device} onChange={(event) => setDevice(event.currentTarget.value)}><option value="">全部</option><option value="obs">OBS</option><option value="midi">MIDI</option></select></label>
      <label>结果<select value={result} onChange={(event) => setResult(event.currentTarget.value)}><option value="">全部</option>{['succeeded', 'failed', 'skipped', 'running', 'queued'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <span>{entries.length} 条</span>
    </section>
    <section className="panel log-table">
      <div className="log-table-header"><span>时间</span><span>级别</span><span>类别</span><span>消息</span><span>设备 / 结果</span></div>
      {entries.map((entry) => <div className={`log-row ${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><strong>{entry.level}</strong><code>{entry.category}</code><div><span>{entry.message}</span>{entry.details ? <small>{JSON.stringify(entry.details)}</small> : null}</div><span>{entry.device ?? '—'} · {entry.result ?? '—'}</span></div>)}
      {entries.length === 0 ? <div className="empty-panel"><FileSearch /><h3>当前筛选没有日志</h3><p>预检、状态变化和 Cue 动作执行后会形成结构化记录。</p></div> : null}
    </section>
  </div>;
}

export function LogsDialog({ notify, onClose }: Props & { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  return createPortal(<div className="diagnostics-log-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="diagnostics-log-sheet" role="dialog" aria-modal="true" aria-label="诊断与日志">
      <button className="icon-button diagnostics-log-close" aria-label="关闭诊断与日志" onClick={onClose}><X /></button>
      <LogsWorkspace notify={notify} />
    </section>
  </div>, document.body);
}

function LogFilter({ label, value, values, onChange, format = (candidate) => candidate }: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
  format?: (value: string) => string;
}): JSX.Element {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.currentTarget.value)}><option value="">全部</option>{values.map((candidate) => <option value={candidate} key={candidate}>{format(candidate)}</option>)}</select></label>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
