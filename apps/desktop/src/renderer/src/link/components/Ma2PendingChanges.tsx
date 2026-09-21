import { useMemo } from 'react';
import type { Ma2SyncObject } from '@tb/schema';
import { ma2PendingChanges } from '../runtime/ma2-pending-changes';
import { useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';

export function Ma2PendingChanges({ playing, onStop }: { playing: boolean; onStop: () => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  const pending = useMemo(() => ma2PendingChanges(project), [project]);
  const automatic = useMa2AutoSyncStore();
  const runtime = useRuntimeStore(state => state.state);
  const externalRunning = project?.playbackSource === 'p1' && runtime !== 'idle';
  if (!pending.length && automatic.status !== 'blocked' && automatic.status !== 'writing') return null;
  const active = Boolean(automatic.request) && automatic.status !== 'blocked';
  return <section className="ma2-pending-changes" aria-label="MA2 待提交变更">
    <div className="settings-header-actions"><strong>MA2 待提交 · {pending.reduce((sum, item) => sum + item.changes.length, 0)} 处变更</strong>
      <button disabled={!active || externalRunning || automatic.status === 'writing' || automatic.status === 'reading' || !pending.length} onClick={() => {
        if (playing) onStop();
        useMa2AutoSyncStore.setState(state => ({ commitRequest: state.commitRequest + 1 }));
      }}>{playing ? '停止并核对提交' : '核对并提交'}</button>
    </div>
    <p role={automatic.status === 'blocked' ? 'alert' : 'status'}>{pending.length && automatic.status === 'verified' ? '本地已有新变更，等待核对提交' : automatic.message}</p>
    <p>本地编辑可撤销、重做；播放期间不会写入 MA2。停止后先检查冲突、写前核对，再写入并回读确认。未绑定的轨道和本地备注不提交。</p>
    {!active ? <p>变更已保留在工程中。请在 MA2 同步中读取并处理冲突，重新扫描后启用自动同步。</p> : null}
    {externalRunning ? <p>请先停止 P1 并释放联动会话，再核对提交。</p> : null}
    {pending.length ? <details><summary>查看待提交变更</summary>{pending.map(item => <div key={`${item.itemId}:${item.bindingId}`}>
      <strong>{item.title} · Timecode {item.target}</strong>
      {item.error ? <p role="alert">无法核对：{item.error}</p> : <ul>{item.changes.map(change => <li key={change.id}>
        {change.before ? change.after ? '修改' : '删除' : '新增'}：{describe(change.before)} → {describe(change.after)}
      </li>)}</ul>}
    </div>)}</details> : null}
  </section>;
}

function describe(object: Ma2SyncObject | null): string {
  if (!object) return '无';
  const properties = object.properties;
  if (object.kind !== 'event') return `${object.kind === 'track' ? '轨道' : '时间线'} ${properties.name ?? ''}${properties.muted === 'true' ? '（静音）' : ''}`;
  const action = properties.action === 'goto' ? `序列 ${properties.sequence} / Cue ${properties.cue}` : properties.action === 'master' ? `主推杆 ${Number(properties.level) * 100}%` : properties.action === 'go' ? '下一步' : '关闭执行器';
  return `${(Number(properties.time) / 1000).toFixed(3)} 秒 · ${action} · 执行器 ${properties.executor}${properties.muted === 'true' ? '（静音）' : ''}`;
}
