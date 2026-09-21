import { Button } from './Button';
import { useCallback, useEffect, useState } from 'react';
import { ModalSurface } from './ModalSurface';
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
  const [level, setLevel] = useState('');
  const [error, setError] = useState('');
  const visibleEntries = entries.filter(entry => !level || entry.level === level);

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
      setError('');
    } catch (error) {
      setError(`读取日志失败：${error instanceof Error ? error.message : String(error)}。请点击刷新重试。`);
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
      setError(`导出诊断包失败：${error instanceof Error ? error.message : String(error)}。请检查保存位置后重新导出。`);
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return <div className="page-stack">
    <header className="page-heading"><div><span className="eyebrow">RUN LOG</span><h2>运行日志</h2><p>按会话、节目、Cue、设备和执行结果定位现场问题。</p></div><div className="heading-actions"><Button className="secondary-button" onClick={() => void refresh()}><RefreshCw />刷新</Button><Button className="primary-button" onClick={() => void exportPackage()}><Download />导出脱敏诊断包</Button></div></header>
    <section className="log-filters panel">
      <LogFilter label="会话" value={sessionId} values={unique(catalog.map((entry) => entry.sessionId))} onChange={setSessionId} format={(value) => value.slice(0, 8)} />
      <LogFilter label="节目" value={itemId} values={unique(catalog.flatMap((entry) => entry.itemId ? [entry.itemId] : []))} onChange={setItemId} format={(value) => project?.rundown.find((item) => item.id === value)?.title ?? value} />
      <LogFilter label="Cue" value={cueId} values={unique(catalog.flatMap((entry) => entry.cueId ? [entry.cueId] : []))} onChange={setCueId} />
      <label>设备<select value={device} onChange={(event) => setDevice(event.currentTarget.value)}><option value="">全部</option><option value="obs">OBS</option><option value="midi">MIDI</option></select></label>
      <label>结果<select value={result} onChange={(event) => setResult(event.currentTarget.value)}><option value="">全部</option>{['succeeded', 'failed', 'skipped', 'running', 'queued'].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>级别<select value={level} onChange={event => setLevel(event.currentTarget.value)}><option value="">全部</option><option value="error">错误</option><option value="warning">警告</option><option value="info">信息</option></select></label>
      <span>{visibleEntries.length} 条</span>
    </section>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <section className="panel log-table">
      <div className="log-table-header"><span>时间</span><span>级别</span><span>类别</span><span>消息</span><span>设备 / 结果</span></div>
      {visibleEntries.map((entry) => <div className={`log-row ${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><strong>{({ error: '错误', warning: '警告', info: '信息' })[entry.level]}</strong><code>{entry.category}</code><div><span>{entry.message}</span>{entry.details ? <details><summary>查看详情</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details> : null}</div><span>{entry.device ?? '—'} · {entry.result ?? '—'}</span></div>)}
      {visibleEntries.length === 0 ? <div className="empty-panel"><FileSearch /><h3>当前筛选没有日志</h3><p>调整筛选条件或点击刷新。预检与 Cue 执行后会生成记录。</p></div> : null}
    </section>
  </div>;
}

export function LogsDialog({ notify, onClose }: Props & { onClose: () => void }): JSX.Element {
  return <ModalSurface className="diagnostics-log-sheet" label="诊断与日志" onClose={onClose}>
      <Button className="icon-button diagnostics-log-close" aria-label="关闭诊断与日志" onClick={onClose}><X /></Button>
      <LogsWorkspace notify={notify} />
  </ModalSurface>;
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
