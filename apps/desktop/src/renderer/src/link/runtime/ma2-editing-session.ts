import { ma2CatalogSchema, type Ma2CatalogRequest } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { ma2PendingChanges } from './ma2-pending-changes';
import { useMa2AutoSyncStore } from './use-ma2-auto-sync';
import { scanMa2Materials } from '../stores/ma2-material-read-store';

let preparing = false;
/** Called only by an explicit connect/read action, never by status polling or page mounting. */
export async function prepareMa2Editing(connection: Ma2CatalogRequest, documentId: number, refresh = false, retry = false): Promise<string> {
  if (preparing) throw new Error('正在载入节目 Cue，请等待当前任务完成；没有重复扫描');
  preparing = true;
  try { return await prepare(connection, documentId, refresh, retry); }
  finally { preparing = false; }
}

async function prepare(connection: Ma2CatalogRequest, documentId: number, refresh: boolean, retry: boolean): Promise<string> {
  const current = () => {
    const state = useDocumentStore.getState();
    if (state.documentId !== documentId) throw new Error('工程已切换，未向新工程载入或同步控台灯光');
    return state;
  };
  if (!current().project?.rundown.length) return 'MA2 已连接；导入 P1 歌曲后，再连接即可载入对应 Cue';
  if (useMa2ReadStore.getState().busy) throw new Error('控台读取正在进行，请等待完成；没有重复扫描');
  if (useMa2AutoSyncStore.getState().status === 'writing') throw new Error('正在写入并回读控台，请完成后再连接或刷新');
  useMa2AutoSyncStore.setState({ request: null });
  const cached = current().project?.ma2ReadState;
  const source = connection.network ? `${connection.network.host}:${connection.network.port}` : '本机 onPC';
  let reuse = false;
  if (!refresh && cached?.source === source && !cached.catalog.incomplete && !cached.catalog.sourceUnverified) {
    // A reconnect verifies the Show identity, without rereading every Timecode.
    const directory = ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ ...connection, targets: [] }));
    current();
    reuse = !directory.incomplete && !directory.sourceUnverified && JSON.stringify(directory.directory) === JSON.stringify(cached.catalog.directory);
  }
  if (!reuse) await scanMa2(connection, retry);
  current();
  await importCachedMa2();
  let libraryNotice = '';
  const read = current().project?.ma2ReadState;
  const pool = current().project?.ma2MaterialLibrary;
  const completePool = pool?.library && pool.source === source && pool.library.directory.show === read?.catalog.directory.show
    && pool.library.directory.generation === read.catalog.directory.generation && !pool.library.incomplete && !pool.library.sourceUnverified && !pool.library.errors.length;
  if (read && !read.catalog.incomplete && !read.catalog.sourceUnverified && (!reuse || !completePool)) {
    try { await scanMa2Materials(connection, retry && pool?.source === source); }
    catch (error) { libraryNotice = `；全控台素材未读完整：${error instanceof Error ? error.message : String(error)}。已读取的歌曲 Cue 保留`; }
    current();
  }
  const project = current().project;
  const state = project?.ma2ReadState;
  if (!project || !state) throw new Error('未取得可用的控台读取结果');
  const bindings = project.rundown.flatMap(item => item.lighting?.ma2Bindings ?? []);
  const retained = bindings.filter(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode').length;
  const pairingNotice = state.failures.length ? `；${state.failures.length} 条未关联，请在“配对与查看 Cue”中查看对应时间线的原因` : '';
  const summary = `${reuse ? '已恢复工程缓存（控台内容更新请点“更新控台读取”）' : '控台读取完成'}；${bindings.length} 条已关联，${retained} 条含原生保留动作${pairingNotice}${libraryNotice}`;
  const reason = state.catalog.incomplete || state.catalog.sourceUnverified ? '读取尚未完整核对'
    : Object.values(state.pairings ?? {}).some(pair => pair.status === 'stale') ? '已有配对需要重新核对'
    : ma2PendingChanges(project).length ? '有连接前的本地修改，请先核对后提交'
    : !bindings.some(binding => !binding.nativeEvents?.length && binding.playback !== 'native-timecode') ? '尚无已验证可写回的时间线' : null;
  if (reason) {
    useMa2AutoSyncStore.setState({ status: 'off', message: `${reason}；已读 Cue 可查看，本地修改不会自动写回` });
    return `${summary}。${reason}，自动写回未启用`;
  }
  useMa2AutoSyncStore.setState({ status: 'off', message: '已准备好；打开实时同步后，停止播放时的编辑会自动写回' });
  return `${summary}。可在顶部打开“实时同步”；启用后停止播放时，拖动结束会核对、写入并回读`;
}
