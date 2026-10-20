import { resolveMa2SongConflict, useMa2SongSyncStore } from '../runtime/ma2-song-sync';
import { useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';

const titles = { 'sequence-name': '序列名称', 'cue-name': 'Cue 名称', 'cue-content': '灯光内容', 'cue-deletion': '删除 Cue', 'cue-removed': '控台已删除 Cue' };
export function Ma2SongConflicts({ itemId, deletionChecklist }: { itemId: string; deletionChecklist?: readonly string[] }): JSX.Element | null {
  const song = useMa2SongSyncStore(state => state.songs[itemId]);
  const enabled = useMa2RealtimePreference(state => state.enabled);
  const conflicts = song?.conflicts?.filter(conflict => conflict.field !== 'cue-deletion' || !conflict.cue || !deletionChecklist?.includes(conflict.cue));
  if (!song || !conflicts?.length) return null;
  return <div className="ma2-song-conflicts" aria-label="两边修改核对">
    <small>只有下面的同一项需要选择，其余修改继续同步。</small>
    {conflicts.map(conflict => <section key={conflict.key}>
      <strong>{conflict.cue ? `Cue ${Number(conflict.cue)} · ` : ''}{titles[conflict.field]}</strong>
      <dl><dt>软件</dt><dd>{conflict.local || '空'}</dd><dt>控台</dt><dd>{conflict.console || '空'}</dd></dl>
      <details><summary>上次确认的内容</summary><p>{conflict.baseline || '空'}</p></details>
      <div><button disabled={!enabled || Boolean(song.requestId)} onClick={() => resolveMa2SongConflict(itemId, conflict.key, 'local')}>采用软件</button><button disabled={!enabled || Boolean(song.requestId)} onClick={() => resolveMa2SongConflict(itemId, conflict.key, 'console')}>采用控台</button></div>
    </section>)}
    {!enabled ? <small>已暂停；开启实时同步后可确认以上修改。</small> : null}
  </div>;
}
