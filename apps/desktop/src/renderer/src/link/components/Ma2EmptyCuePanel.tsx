import { useEffect, useRef, useState } from 'react';
import { isShowWait, toUserErrorMessage, type ConsoleCueReference } from '@tb/core/link';
import type { Ma2CueDeleteResult, Ma2EffectLibrary } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { useShowGate } from '../stores/show-state-store';
import { Button } from '../ui';
import { CuePoolGrid } from './CuePoolGrid';
import { Ma2CueDeleteDialog } from './Ma2CueDeleteDialog';

type Candidate = ConsoleCueReference & { name: string; key: string };
const keyFor = (sequence: number, cue: string) => `${sequence}/${Number(cue)}`;

export function Ma2EmptyCuePanel({ onBack }: { onBack: () => void }): JSX.Element {
  const directory = useDocumentStore(s => s.project?.ma2MaterialLibrary?.library?.directory);
  const source = useDocumentStore(s => s.project?.ma2MaterialLibrary?.source);
  const documentId = useDocumentStore(s => s.documentId);
  const request = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Candidate[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<Candidate[] | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pass, setPass] = useState(0);
  const gate = useShowGate('ma2.sync.read');
  const [waiting, setWaiting] = useState(false);
  const { show, generation, version } = directory ?? {};
  const [schedule, setSchedule] = useState(0);
  useEffect(() => {
    if (waiting && gate.kind === 'allow') { setWaiting(false); setSchedule(value => value + 1); }
  }, [waiting, gate.kind]);
  useEffect(() => {
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true); setError(''); setMessage('正在检查控台'); setRows([]); setSelection(new Set()); setDeleting(null);
    let started = false;
    const run = async (): Promise<void> => {
      if (!show || !generation || !version) { setMessage('请先连接并读取控台素材。'); setBusy(false); return; }
      try {
        const connection = await ma2MaterialConnection(true);
        if (request.current !== id) return;
        if (!connection.network || source !== `${connection.network.host}:${connection.network.port}`) throw new Error('请连接读取这些素材时使用的控台');
        const candidates = (seqs: Ma2EffectLibrary['sequences']): Candidate[] => seqs.flatMap(seq => seq.cues.map(cue => ({
          kind: 'single', sequence: seq.sequence, cue: cue.number, key: keyFor(seq.sequence, cue.number), name: cue.name || seq.name || '未命名'
        })));
        started = true;
        const result = await window.tbLink.readMa2EffectLibrary({ ...connection, details: 'empty-cues', progressId: id, expectedSource: { show, generation, version } }, update => {
          if (request.current !== id) return;
          setMessage(update.detail);
          const found = candidates(update.sequences ?? []);
          if (found.length) setRows(previous => previous.concat(found));
        });
        if (request.current !== id) return;
        const found = candidates(result.sequences);
        setRows(found); setMessage(`已检查 ${result.sequences.length} 个序列，找到 ${found.length} 个空 Cue`);
        if (result.errors.length) setError(result.errors.map(f => `序列 ${f.sequence} · ${f.message}`).join('；'));
      } catch (cause) {
        if (request.current !== id) return;
        if (isShowWait(cause)) { setMessage(toUserErrorMessage(cause)); setWaiting(true); }
        else { setMessage('检查未完成'); setError(toUserErrorMessage(cause)); }
      } finally {
        started = false;
        if (request.current === id) setBusy(false);
      }
    };
    void run();
    return () => {
      request.current = null;
      if (started) void window.tbLink.cancelMa2Read(id).catch((cause: unknown) => console.error('取消空 Cue 检查失败', cause));
    };
  }, [documentId, source, show, generation, version, pass, schedule]);
  const removeConfirmed = (deleted: Ma2CueDeleteResult['deleted']): void => {
    const removed = new Set(deleted.map(ref => keyFor(ref.sequence, ref.cue)));
    setRows(current => current.filter(row => !removed.has(row.key)));
    setSelection(new Set()); setMessage(`控台已确认删除 ${removed.size} 个 Cue`);
  };
  return <section className="ma2-sequence-preview" aria-label="空 Cue 分类">
    <header className="ma2-material-menubar"><Button size="sm" variant="ghost" onClick={onBack}>返回控台素材</Button><strong>空 Cue</strong>
      <Button disabled={busy || !directory} onClick={() => setPass(value => value + 1)}>检测空 Cue</Button>
      {busy && <Button onClick={() => { if (request.current) void window.tbLink.cancelMa2Read(request.current).catch((cause: unknown) => setError(String(cause))); }}>取消检测</Button>}
      {rows.length > 0 && <Button onClick={() => setSelection(new Set(rows.slice(0, 200).map(row => row.key)))}>{rows.length > 200 ? '选择前 200 个' : '全选'}</Button>}
      <Button disabled={!selection.size || busy} onClick={() => setDeleting(rows.filter(row => selection.has(row.key)))}>删除所选{selection.size ? `（${selection.size}）` : ''}</Button>
    </header>
    <p className="ma2-material-message" role="status">{message || (directory ? '检测没有灯具数据或所有属性都为零的 Cue。' : '请先连接并读取控台素材。')}</p>
    {error && <p className="ma2-material-message" role="alert">{error}</p>}
    <CuePoolGrid keys={rows.map(row => row.key)} label="检测到的空 Cue" cellWidth={156} rowHeight={50} render={index => {
      const row = rows[index]!;
      return <button aria-pressed={selection.has(row.key)} disabled={!selection.has(row.key) && selection.size >= 200}
        onClick={() => setSelection(current => { const next = new Set(current); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; })}>
        <strong>{row.name}</strong><small>序列 {row.sequence} · Cue {Number(row.cue)}</small></button>;
    }}/>
    {deleting && <Ma2CueDeleteDialog refs={deleting} onDeleted={removeConfirmed} onClose={() => setDeleting(null)}/>}
  </section>;
}
