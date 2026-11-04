import { Button, Card, Field, Notice, Select } from '../ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw } from 'lucide-react';
import type { LinkLogEntryDto } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { DiagnosticExports } from './DiagnosticExports';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Props = { notify: (message: string, tone?: 'info' | 'error') => void };

/** 运行日志: export for support, then the latest records with filters. */
export function LogsWorkspace({ notify }: Props): JSX.Element {
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

  const filtered = Boolean(sessionId || itemId || cueId || device || result || level);
  return <div className="settings-stack">
    <DiagnosticExports />
    <Card title="最近的记录" description="显示最近 500 条，最多查找最近 20 次启动的记录。本机日志保留 30 天，最多 200 MB。"
      actions={<Button variant="secondary" size="sm" icon={RefreshCw} loading={loading} onClick={() => void refresh()}>刷新</Button>}>
      <div className="settings-log-filters" role="group" aria-label="筛选日志">
        <LogFilter label="启动批次" value={sessionId} values={unique(catalog.map((entry) => entry.sessionId))} onChange={setSessionId} format={(value) => value.slice(0, 8)} />
        <LogFilter label="节目" value={itemId} values={unique(catalog.flatMap((entry) => entry.itemId ? [entry.itemId] : []))} onChange={setItemId} format={(value) => project?.rundown.find((item) => item.id === value)?.title ?? value} />
        <LogFilter label="Cue" value={cueId} values={unique(catalog.flatMap((entry) => entry.cueId ? [entry.cueId] : []))} onChange={setCueId} />
        <LogFilter label="设备" value={device} values={unique(catalog.flatMap(entry => entry.device ? [entry.device] : []))} onChange={setDevice} />
        <LogFilter label="结果" value={result} values={Object.keys(resultNames)} onChange={setResult} format={(value) => resultNames[value as keyof typeof resultNames]} />
        <LogFilter label="级别" value={level} values={['error', 'warning', 'info']} onChange={setLevel} format={(value) => levelNames[value as LinkLogEntryDto['level']]} />
      </div>
      <div className="settings-actions-row">
        <span className="settings-saved" role="status">{loading ? '正在读取…' : `${visibleEntries.length} 条`}</span>
        {filtered ? <Button variant="ghost" size="sm" onClick={() => { setSessionId(''); setItemId(''); setCueId(''); setDevice(''); setResult(''); setLevel(''); }}>清除筛选</Button> : null}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {visibleEntries.length ? <div className="settings-log-list">
        {visibleEntries.map((entry) => <article className="settings-log-row" data-level={entry.level} key={entry.id}>
          <header>
            <strong>{levelNames[entry.level]}</strong>
            <time>{new Date(entry.timestamp).toLocaleString()}</time>
            <span>{categoryNames[entry.category]}</span>
            <span>{entry.device ?? '—'} · {entry.result ? resultNames[entry.result] : '—'}</span>
          </header>
          <p>{entry.message}</p>
          {entry.details ? <details><summary>查看详情</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details> : null}
        </article>)}
      </div> : null}
      {!loading && !error && visibleEntries.length === 0 ? <div className="settings-empty"><FileSearch aria-hidden="true" /><strong>{filtered ? '当前筛选没有日志' : '还没有运行日志'}</strong><p>换个筛选条件，或点“刷新”。开播前检查和 Cue 执行后会产生记录。</p></div> : null}
    </Card>
  </div>;
}

const levelNames: Record<LinkLogEntryDto['level'], string> = { error: '错误', warning: '警告', info: '信息' };
const resultNames = { succeeded: '成功', failed: '失败', skipped: '跳过', running: '执行中', queued: '等待中' };
const categoryNames = { state: '状态', action: '动作', device: '设备', preflight: '开播前检查', operator: '操作', system: '系统' };

function LogFilter({ label, value, values, onChange, format = (candidate) => candidate }: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
  format?: (value: string) => string;
}): JSX.Element {
  return <Field label={label} stacked>{props => <Select {...props} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
    <option value="">全部</option>
    {values.map((candidate) => <option value={candidate} key={candidate}>{format(candidate)}</option>)}
  </Select>}</Field>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
