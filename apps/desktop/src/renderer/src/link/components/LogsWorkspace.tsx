import { Button } from '../ui/Button';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw } from 'lucide-react';
import type { LinkLogEntryDto } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { DiagnosticExports } from './DiagnosticExports';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Props = { settings?: boolean; notify: (message: string, tone?: 'info' | 'error') => void };

export function LogsWorkspace({ notify, settings = false }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const [entries, setEntries] = useState<LinkLogEntryDto[]>([]);
  const [catalog, setCatalog] = useState<LinkLogEntryDto[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [itemId, setItemId] = useState('');
  const [cueId, setCueId] = useState('');
  const [device, setDevice] = useState('');
  const [result, setResult] = useState('');
  const [level, setLevel] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const visibleEntries = entries.filter(entry => !level || entry.level === level);

  const refresh = useCallback(async (): Promise<void> => {
    const id = ++request.current; setLoading(true);
    try {
      const [allEntries, filteredEntries] = await Promise.all([
        linkDesktopViewModel.queryLogs({ limit: 500 }),
        linkDesktopViewModel.queryLogs({
        limit: 500,
        ...(sessionId ? { sessionId } : {}),
        ...(itemId ? { itemId } : {}),
        ...(cueId ? { cueId } : {}),
        ...(device ? { device } : {}),
        ...(result ? { result: result as LinkLogEntryDto['result'] } : {})
        })
      ]);
      if (id !== request.current) return;
      setCatalog(allEntries);
      setEntries(filteredEntries);
      setError('');
    } catch (error) {
      if (id !== request.current) return;
      setError(`读取日志失败：${error instanceof Error ? error.message : String(error)}。请点“刷新”重试。`);
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally { if (id === request.current) setLoading(false); }
  }, [cueId, device, itemId, notify, result, sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <div className={`page-stack ${settings ? 'settings-log-page' : 'diagnostics-log-page'}`}>
    <header className={settings ? 'settings-log-heading' : 'page-heading'}><div>{!settings ? <h2>运行日志</h2> : null}<p>显示最近 500 条，最多查找最近 20 次启动的记录。导出时按所选时间范围（默认最近 7 天），不受筛选影响；本机日志保留 30 天，最多 200 MB。</p></div><div className="heading-actions"><Button className="secondary-button" loading={loading} onClick={() => void refresh()}><RefreshCw />刷新</Button></div></header>
    <DiagnosticExports />
    <section className="log-filters panel">
      <LogFilter label="启动批次" value={sessionId} values={unique(catalog.map((entry) => entry.sessionId))} onChange={setSessionId} format={(value) => value.slice(0, 8)} />
      <LogFilter label="节目" value={itemId} values={unique(catalog.flatMap((entry) => entry.itemId ? [entry.itemId] : []))} onChange={setItemId} format={(value) => project?.rundown.find((item) => item.id === value)?.title ?? value} />
      <LogFilter label="Cue" value={cueId} values={unique(catalog.flatMap((entry) => entry.cueId ? [entry.cueId] : []))} onChange={setCueId} />
      <LogFilter label="设备" value={device} values={unique(catalog.flatMap(entry => entry.device ? [entry.device] : []))} onChange={setDevice} />
      <label>结果<select value={result} onChange={(event) => setResult(event.currentTarget.value)}><option value="">全部</option>{Object.entries(resultNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>级别<select value={level} onChange={event => setLevel(event.currentTarget.value)}><option value="">全部</option><option value="error">错误</option><option value="warning">警告</option><option value="info">信息</option></select></label>
      <span role="status">{loading ? '正在读取…' : `${visibleEntries.length} 条`}</span>
      <Button className="secondary-button" onClick={() => { setSessionId(''); setItemId(''); setCueId(''); setDevice(''); setResult(''); setLevel(''); }}>清除筛选</Button>
    </section>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <section className="panel log-table">
      <div className="log-table-header"><span>时间</span><span>级别</span><span>类别</span><span>消息</span><span>设备 / 结果</span></div>
      {visibleEntries.map((entry) => <div className={`log-row ${entry.level}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleString()}</time><strong>{({ error: '错误', warning: '警告', info: '信息' })[entry.level]}</strong><code>{categoryNames[entry.category]}</code><div><span>{entry.message}</span>{entry.details ? <details><summary>查看详情</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details> : null}</div><span>{entry.device ?? '—'} · {entry.result ? resultNames[entry.result] : '—'}</span></div>)}
      {!loading && !error && visibleEntries.length === 0 ? <div className="empty-panel"><FileSearch /><h3>{sessionId || itemId || cueId || device || result || level ? '当前筛选没有日志' : '暂无运行日志'}</h3><p>换个筛选条件，或点“刷新”。开播前检查和 Cue 执行后会产生记录。</p></div> : null}
    </section>
  </div>;
}

const resultNames = { succeeded: '成功', failed: '失败', skipped: '跳过', running: '执行中', queued: '等待中' };
const categoryNames = { state: '状态', action: '动作', device: '设备', preflight: '开播前检查', operator: '操作', system: '系统' };

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
