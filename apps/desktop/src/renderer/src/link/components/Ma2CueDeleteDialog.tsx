import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import type { Ma2CueDeletePlan, Ma2CueDeletePrepare, Ma2CueDeleteResult, Ma2ReadProgress } from '@tb/schema';
import { applyMa2CueDeletionCommand, type ConsoleCueReference } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { ma2MaterialConnection, useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2AttributeStore } from '../stores/ma2-attribute-store';
import { saveDocument } from '../project-document';
import '../lighting-attributes.css';

export function Ma2CueDeleteDialog({ refs, onClose }: { refs: ConsoleCueReference[]; onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Ma2CueDeletePlan | null>(null);
  const [request, setRequest] = useState<{ input: Ma2CueDeletePrepare; documentId: number } | null>(null);
  const [result, setResult] = useState<Ma2CueDeleteResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const progress = (value: Ma2ReadProgress): void => useMa2AttributeStore.setState({ progress: value });
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (useMa2AttributeStore.getState().busy || useMa2MaterialReadStore.getState().busy) { setError('请等待当前控台读取结束'); return; }
    setBusy(true); setError('');
    useMa2AttributeStore.setState({ busy: true, activeId: null, progress: null, message: '正在核对空 Cue 删除操作' });
    try { await action(); }
    catch(cause) { const text = cause instanceof Error ? cause.message : String(cause); setError(text); useMa2AttributeStore.setState({ message: text }); }
    finally { setBusy(false); useMa2AttributeStore.setState({ busy: false, activeId: null, progress: null }); }
  };
  // Must land on disk first: the main process checks Cue usage and the console source
  // against the saved project file, both when listing and again before deleting.
  const save = async (): Promise<{ path: string; documentId: number; projectId: string }> => {
    const current = useDocumentStore.getState();
    if (!current.project) throw new Error('请先打开工程');
    const outcome = await saveDocument();
    if (outcome.status === 'failed') throw new Error(outcome.message);
    if (outcome.status === 'canceled') throw new Error('删除空 Cue 前需要先保存工程；本次未执行');
    if (useDocumentStore.getState().documentId !== current.documentId) throw new Error('工程已切换');
    return { path: outcome.path, documentId: current.documentId, projectId: current.project.projectId };
  };
  const prepare = (): void => { void run(async () => {
    setPlan(null); setRequest(null);
    if (refs.length > 200) throw new Error('一次最多核对 200 个 Cue，请先多选需要清理的部分');
    const state = useDocumentStore.getState(); const cache = state.project?.ma2MaterialLibrary;
    if (!cache?.library || cache.library.sourceUnverified) throw new Error('请先读取控台素材和属性');
    const connection = await ma2MaterialConnection();
    if (!connection.network || `${connection.network.host}:${connection.network.port}` !== cache.source) throw new Error('请连接素材来源的 MA2 网络控台');
    const saved = await save(); const {show,generation,version} = cache.library.directory;
    const input: Ma2CueDeletePrepare = { network: connection.network, expectedSource: {show,generation,version}, projectId:saved.projectId, projectPath:saved.path, refs:refs.map(({sequence,cue})=>({sequence,cue})), progressId:crypto.randomUUID() };
    const value = await window.tbLink.prepareMa2CueDeletion(input,progress);
    if (useDocumentStore.getState().documentId !== saved.documentId) throw new Error('工程已切换，请重新核对');
    setRequest({input,documentId:saved.documentId}); setPlan(value);
    useMa2AttributeStore.setState({message:`空 Cue 清单已核对：${value.items.filter(item=>item.eligible).length} 项可删除，等待确认`});
  }); };
  const commit = (): void => { if (!plan || !request) return; void run(async () => {
    if (useDocumentStore.getState().documentId !== request.documentId) throw new Error('工程已切换，未删除');
    await save();
    const base = { network:request.input.network, expectedSource:request.input.expectedSource, projectId:request.input.projectId, projectPath:request.input.projectPath };
    const value = await window.tbLink.commitMa2CueDeletion({...base,token:plan.token,progressId:crypto.randomUUID()},progress);
    setResult(value); setPlan(null);
    if (useDocumentStore.getState().documentId !== request.documentId) throw new Error('控台操作已完成，但工程已切换；请回到原工程读取控台');
    if (value.deleted.length || value.error) {
      useDocumentStore.getState().executeForDocument(request.documentId,applyMa2CueDeletionCommand(`${base.network.host}:${base.network.port}`,value));
      useDocumentStore.getState().markConsoleSynced(request.documentId);
    }
    setError(value.error ?? '');
    useMa2AttributeStore.setState({message:`已回读确认删除 ${value.deleted.length} 个空 Cue${value.error ? `；${value.error}` : ''}`});
  }); };
  return createPortal(<dialog ref={dialog} className="lighting-attribute-dialog" aria-label="删除控台空 Cue" onCancel={event=>{if(busy)event.preventDefault();else onClose();}}>
    <header><strong>删除控台空 Cue</strong><button aria-label="关闭删除清单" onClick={onClose} disabled={busy}><X/></button></header>
    <p>这会删除 MA2 控台中的 Cue，并同步更新素材列表。先核对清单，确认后才会执行。</p>
    {!plan && !result ? <><p>已选择 {refs.length} 个候选 Cue。将重新检查属性、Part、命令、继承可能性及时间线引用。</p><button disabled={busy} onClick={prepare}>{busy ? '正在核对，进度见左侧…' : '读取并生成删除清单'}</button></> : null}
    {plan ? <><div className="attribute-cue-list"><table className="cue-delete-list"><thead><tr><th>名称</th><th>序列 / Cue</th><th>核对结果</th></tr></thead><tbody>{plan.items.map(item=><tr key={`${item.sequence}:${item.cue}`}><td>{item.name}</td><td>{item.sequence} / {Number(item.cue)}</td><td>{item.eligible?'可删除：':'不删除：'}{item.reason}</td></tr>)}</tbody></table></div>
      <p>删除前备份完整序列。删除会改变后续 Go 的步序；控台宏、外部控制及仅用 Go 的调用仍需现场核对。软件撤销不会恢复控台删除。</p>
      <footer className="cue-delete-actions"><button onClick={onClose} disabled={busy}>取消</button><button onClick={prepare} disabled={busy}>重新核对</button><button className="danger" disabled={busy || !plan.items.some(item=>item.eligible)} onClick={commit}><Trash2/>{busy?'正在备份和删除…':`确认删除控台 ${plan.items.filter(item=>item.eligible).length} 个空 Cue`}</button></footer></> : null}
    {result ? <><p>已回读确认删除 {result.deleted.length} 个 Cue。</p><details><summary>查看序列备份</summary><ul>{result.backups.map(path=><li key={path}>{path}</li>)}</ul></details><button disabled={busy} onClick={onClose}>关闭</button></> : null}
    {error ? <p role="alert">{error}</p> : null}
  </dialog>,document.body);
}
