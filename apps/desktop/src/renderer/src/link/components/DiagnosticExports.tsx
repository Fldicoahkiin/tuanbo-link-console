import { useState } from 'react';
import { Download, FolderOpen } from 'lucide-react';
import { Button, Card, Disclosure, Field, Notice, Select, Switch, TextArea } from '../ui';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { diagnosticContext } from '../view-models/diagnostic-context';

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
      const path = kind === 'text' ? await desktop.exportLogs({ days }) : await desktop.exportDiagnosticPackage({ problem: note.trim(), ...diagnosticContext(includeMa2) }, { days });
      setMessage(path ? `已导出：${path}` : '已取消导出。');
    } catch (failure) { setError(`操作失败：${failure instanceof Error ? failure.message : String(failure)}`); }
    finally { setBusy(false); }
  };
  return <Card className="diagnostic-exports" title="导出日志与诊断" description="要发给售后排查，用“导出诊断包”或到「问题反馈」直接提交；自己查看用“导出日志”。导出按所选时间范围，不受下面的筛选影响。" aria-label="导出日志与诊断">
    <Field label="导出范围">{props => <Select {...props} aria-label="导出范围" width="auto" value={days} disabled={busy} onChange={event => setDays(event.currentTarget.value === '1' ? 1 : event.currentTarget.value === '30' ? 30 : 7)}>
      <option value="1">最近 1 天</option><option value="7">最近 7 天</option><option value="30">最近 30 天（全部保留的日志）</option>
    </Select>}</Field>
    <Disclosure title="附加问题说明与灯光数据" description="选填">
      <p>诊断包里有软件版本、电脑信息、连接状态和日志，把这个文件发给售后就能排查。密码会隐藏，不含音视频素材。</p>
      <Field label="问题描述" stacked help="选填">{props => <TextArea {...props} rows={2} maxLength={2000} value={note} onChange={event => setNote(event.currentTarget.value)} placeholder="例如：22:10 点击播放后没有出灯，重开后仍能复现" />}</Field>
      <Switch label="包含 MA2 原始数据" help="当前工程已读取的控台数据，排查 Cue、配对和转换问题时有用" checked={includeMa2} onChange={event => setIncludeMa2(event.currentTarget.checked)} />
    </Disclosure>
    <div className="settings-actions-row">
      <Button variant="primary" icon={Download} loading={busy} disabled={busy} onClick={() => void run('package')}>{busy ? '正在处理…' : '导出诊断包'}</Button>
      <Button variant="secondary" icon={Download} disabled={busy} onClick={() => void run('text')}>导出日志</Button>
      <Button variant="secondary" icon={FolderOpen} disabled={busy} onClick={() => void run('folder')}>打开日志文件夹</Button>
    </div>
    {message ? <p className="feedback-outcome" role="status">{message}</p> : null}
    {error ? <Notice tone="error">{error}</Notice> : null}
  </Card>;
}
