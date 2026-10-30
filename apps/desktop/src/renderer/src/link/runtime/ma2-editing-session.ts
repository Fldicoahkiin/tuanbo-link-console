import { ma2CatalogSchema, type Ma2CatalogRequest } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { ma2PendingChanges } from '@tb/core/link';
import { ma2ConsoleWriting } from '../stores/ma2-sync-store';
import { scanMa2Materials } from '../stores/ma2-material-read-store';

let preparing = false;
/** Called only by an explicit connect/read action, never by status polling or page mounting. */
export async function prepareMa2Editing(connection: Ma2CatalogRequest, documentId: number, refresh = false, retry = false): Promise<string> {
  if (preparing) throw new Error('正在载入节目 Cue，请等这次完成');
  preparing = true;
  try { return await prepare(connection, documentId, refresh, retry); }
  finally { preparing = false; }
}

async function prepare(connection: Ma2CatalogRequest, documentId: number, refresh: boolean, retry: boolean): Promise<string> {
  const current = () => {
    const state = useDocumentStore.getState();
    if (state.documentId !== documentId) throw new Error('工程已切换，没有把控台灯光载入或同步到新工程');
    return state;
  };
  if (!current().project?.rundown.length) return 'MA2 已连接。导入 P1 歌曲后重新连接，就能载入对应的 Cue';
  if (useMa2ReadStore.getState().busy) throw new Error('正在读取控台，请等这次完成');
  if (ma2ConsoleWriting()) throw new Error('正在写入控台并确认，请完成后再连接或刷新');
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
    catch (error) { libraryNotice = `；控台素材没有读全：${error instanceof Error ? error.message : String(error)}。已读到的歌曲 Cue 会保留`; }
    current();
  }
  const project = current().project;
  const state = project?.ma2ReadState;
  if (!project || !state) throw new Error('没有读到可用的控台数据');
  const bindings = project.rundown.flatMap(item => item.lighting?.ma2Bindings ?? []);
  const retained = bindings.filter(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode').length;
  const pairingNotice = state.failures.length ? `；${state.failures.length} 条没能放进歌曲，原因可在“控台时间线”里查看` : '';
  const summary = `${reuse ? '已用工程里保存的控台数据（控台有改动请点“更新控台读取”）' : '控台读取完成'}；${bindings.length} 条已关联，${retained} 条含控台原样动作（这些动作原样保留，其余 Cue 可以改并写回）${pairingNotice}${libraryNotice}`;
  const edited = ma2PendingChanges(project).length;
  const note = state.catalog.incomplete || state.catalog.sourceUnverified ? '。控台还没读完整，读到的 Cue 可以查看，没读到的部分不会写回'
    : edited ? `。有 ${edited} 条时间线带着连接前做的本地修改：同步时先读控台比对，两边改了同一处以联动台为准，控台上的旧版本写入前备份在控台上`
    : !bindings.length ? '。还没有已关联的时间线' : '';
  return `${summary}${note}。灯光工作台左下角的“实时同步”开着时，停止播放后每次改完都会自动写入控台并回读确认`;
}
