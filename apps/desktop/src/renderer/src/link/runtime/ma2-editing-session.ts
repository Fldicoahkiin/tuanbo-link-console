import { ma2CatalogSchema, ma2EffectLibrarySchema, type Ma2ObjectDirectory, type Ma2Catalog, type Ma2CatalogRequest } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { importCachedMa2, scanMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { ma2MtcConflictTargets, ma2PendingChanges, saveMa2ReadStateCommand, saveMa2MaterialLibraryCommand } from '@tb/core/link';
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
  if (!current().project?.rundown.length) return 'MA2 已连接。可以在“歌曲导入与同步”里点“导入 P1 音乐并匹配控台 Cue”。';
  if (useMa2ReadStore.getState().busy) throw new Error('正在读取控台，请等这次完成');
  if (ma2ConsoleWriting()) throw new Error('正在写入控台并确认，请完成后再连接或刷新');
  const opened = current().project;
  const knownTargets = new Set(opened?.ma2ReadState?.catalog.entries.filter(entry => !entry.error).map(entry => entry.target));
  const associated = opened?.rundown.flatMap(item => [
    ...(item.lighting?.ma2Bindings ?? []).map(binding => binding.timecode),
    ...(item.lighting?.consoleSong?.timecode ? [item.lighting.consoleSong.timecode.number] : [])
  ]).filter(target => knownTargets.has(target)) ?? [];
  let verifiedDirectory: Ma2ObjectDirectory | undefined;
  let refreshTimelines = refresh;
  let conflict = '';
  if (connection.network) {
    const progressId = crypto.randomUUID();
    useMa2ReadStore.setState({ busy: true, activeId: progressId, progress: null, message: '正在准备控台选曲' });
    const unsubscribe = useDocumentStore.subscribe(state => {
      if (state.documentId !== documentId) void window.tbLink.cancelMa2Read(progressId).catch(error => useMa2ReadStore.setState({ message: String(error) }));
    });
    try {
      if (!refresh && associated.length) {
        const read = ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ ...connection, targets: [] }));
        current();
        if (read.incomplete || read.sourceUnverified) throw new Error('控台时间线目录还没读完，工程里的灯光和素材已保留');
        verifiedDirectory = read.directory;
        const live = new Set(read.directory.entries.map(entry => entry.target));
        if (associated.every(target => !live.has(target))) {
          throw new Error(`当前 Show「${read.directory.show}」没有工程关联的 Timecode ${[...new Set(associated)].join('、')}。工程里的灯光和素材已保留，请打开对应 Show 后再连接。`);
        }
      }
      const expectedSource = verifiedDirectory && { show: verifiedDirectory.show, generation: verifiedDirectory.generation, version: verifiedDirectory.version };
      if (await window.tbLink.prepareMa2Playback({ network: connection.network, progressId, ...(expectedSource && { expectedSource }) }, progress => useMa2ReadStore.setState({ progress }))) refreshTimelines = true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      useMa2ReadStore.setState({ message: `控台选曲检查未完成：${reason}` });
      if (!ma2MtcConflictTargets(reason)) throw error;
      // Keep playback isolation unconfirmed. The operator needs the actual timelines to repair the conflict.
      refreshTimelines = true;
      conflict = reason;
    } finally { unsubscribe(); useMa2ReadStore.setState({ busy: false, activeId: null, progress: null }); }
  }
  current();
  const cached = current().project?.ma2ReadState;
  const source = connection.network ? `${connection.network.host}:${connection.network.port}` : '本机 onPC';
  let reuse = false;
  if (!refreshTimelines && cached?.source === source && !cached.catalog.incomplete && !cached.catalog.sourceUnverified
    && coversDirectory(cached.catalog.directory, cached.catalog.entries.filter(entry => !entry.error).map(entry => entry.target))) {
    // A reconnect verifies the Show identity, without rereading every Timecode.
    const read: Pick<Ma2Catalog, 'directory' | 'incomplete' | 'sourceUnverified'> = verifiedDirectory ? { directory: verifiedDirectory } : ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ ...connection, targets: [] }));
    const latest = current();
    reuse = !read.incomplete && !read.sourceUnverified && latest.project?.ma2ReadState === cached && sameDirectory(read.directory, cached.catalog.directory);
    if (reuse && read.directory.generation !== cached.catalog.directory.generation) {
      latest.executeForDocument(documentId, saveMa2ReadStateCommand({ ...cached, catalog: { ...cached.catalog, directory: read.directory } }));
    }
  }
  if (!reuse) await scanMa2(connection, retry && !conflict);
  current();
  await importCachedMa2();
  let libraryNotice = '';
  const read = current().project?.ma2ReadState;
  const pool = current().project?.ma2MaterialLibrary;
  if (read && !read.catalog.incomplete && !read.catalog.sourceUnverified) {
    try {
      let reusePool = false;
      if (!refresh && pool?.source === source && pool.library && !pool.library.incomplete && !pool.library.sourceUnverified && !pool.library.errors.length
        && coversDirectory(pool.library.directory, pool.library.sequences.map(entry => entry.sequence)) && pool.library.directory.show === read.catalog.directory.show
        && pool.library.directory.version === read.catalog.directory.version) {
        const checked = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...connection, targets: [] }));
        const latest = current();
        reusePool = latest.project?.ma2MaterialLibrary === pool && !checked.incomplete && !checked.sourceUnverified
          && checked.directory.generation === read.catalog.directory.generation && sameDirectory(checked.directory, pool.library.directory);
        if (reusePool && checked.directory.generation !== pool.library.directory.generation) {
          latest.executeForDocument(documentId, saveMa2MaterialLibraryCommand(source, { ...pool.library, directory: checked.directory }));
        }
      }
      if (!reusePool) await scanMa2Materials(connection, retry && pool?.source === source);
    } catch (error) { libraryNotice = `；控台素材没有读全：${error instanceof Error ? error.message : String(error)}。已读到的歌曲 Cue 会保留`; }
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
    : edited ? `。${edited} 条时间线保留了连接前做的本地修改`
    : !bindings.length ? '。还没有已关联的时间线' : '';
  if (conflict) return `${summary}${note}。控台选曲还没准备好：${conflict}`;
  return `${summary}${note}。在灯光工作台点“同步当前节目”可核对两边的改动`;
}

// The bridge gets a new generation when it is installed again. The cached Cue data
// keeps its original read time. The sync service still reads the actual song before writing.
function sameDirectory(fresh: Ma2ObjectDirectory, saved: Ma2ObjectDirectory): boolean {
  return fresh.show === saved.show && fresh.version === saved.version && JSON.stringify(fresh.entries) === JSON.stringify(saved.entries);
}

function coversDirectory(directory: Ma2ObjectDirectory, numbers: number[]): boolean {
  const available = new Set(numbers);
  return available.size === directory.entries.length && directory.entries.every(entry => available.has(entry.target));
}
