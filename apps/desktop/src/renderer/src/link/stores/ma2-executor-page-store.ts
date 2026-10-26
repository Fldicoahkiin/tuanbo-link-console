import { create } from 'zustand';
import { ma2ExecutorPageSchema, ma2ExecutorPageDirectorySchema, ma2ExecutorUpdateResultSchema, type Ma2ExecutorPage, type Ma2ExecutorPageDirectory, type Ma2ExecutorUpdateRequest } from '@tb/schema';
import { currentMa2LayoutScope, ma2LayoutConnection } from './ma2-layout-store';
import { applyMa2ExecutorChangeCommand, ma2ExecutorDeletionUses, mergeMa2MetadataCommand } from '@tb/core/link';
import { useDocumentStore } from './document-store';

export type Ma2ExecutorBand = 'upper' | 'fader' | 'lower';
type PageState = { scope: string; kind: 'button' | 'fader' | 'layout'; page: number; selectedPages: { button: number | null; fader: number | null }; bandPages: Record<Ma2ExecutorBand, number | null>; activeBand: Ma2ExecutorBand; slot: number | null; navigation: number; directory: Ma2ExecutorPageDirectory | null; pages: Record<number, Ma2ExecutorPage>; busy: boolean; mutating: boolean; scanning: boolean; completed: number; total: number; complete: boolean; error: string; pageErrors: Record<number, string>; requestId: string | null };
const initial = (): Omit<PageState, 'scope' | 'navigation'> => ({ kind: 'button', page: 1, selectedPages: { button: null, fader: null }, bandPages: { upper: null, fader: null, lower: null }, activeBand: 'upper', slot: null, directory: null, pages: {}, busy: false, mutating: false, scanning: false, completed: 0, total: 0, complete: false, error: '', pageErrors: {}, requestId: null });
export const useMa2ExecutorPageStore = create<PageState>(() => ({ ...initial(), scope: '', navigation: 0 }));
function executorScopeIdentity(value: string): string {
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 6 ? JSON.stringify([parts[0], parts[1], parts[2], parts[4], parts[5]]) : value;
  } catch { return value; }
}
export function prepareMa2ExecutorPages(): string {
  const scope = currentMa2LayoutScope();
  const previous = useMa2ExecutorPageStore.getState();
  if (previous.scope !== scope) {
    const sameConsole = previous.scope && executorScopeIdentity(previous.scope) === executorScopeIdentity(scope);
    useMa2ExecutorPageStore.setState({ ...initial(), scope, navigation: 0, ...(sameConsole ? { kind: previous.kind, page: previous.page, bandPages: previous.bandPages, selectedPages: previous.selectedPages, activeBand: previous.activeBand, slot: previous.slot } : {}) });
  }
  return scope;
}
export function locateMa2Executor(page: number, slot: number): void {
  prepareMa2ExecutorPages();
  const kind = slot >= 101 ? 'button' : 'fader';
  const band = kind === 'fader' ? 'fader' : 'upper';
  useMa2ExecutorPageStore.setState(state => ({ kind, page, slot, activeBand: band, bandPages: { ...state.bandPages, [band]: page }, selectedPages: { ...state.selectedPages, [kind]: page }, navigation: state.navigation + 1 }));
}
export function selectMa2ExecutorBandPage(band: Ma2ExecutorBand, page: number): void {
  if (!Number.isInteger(page) || page < 1 || page > 9999) throw new Error('请输入 1–9999 的页码');
  prepareMa2ExecutorPages();
  useMa2ExecutorPageStore.setState(state => ({ activeBand: band, page, slot: null, bandPages: { ...state.bandPages, [band]: page }, error: '' }));
}
export function selectMa2ExecutorPageKind(kind: 'button' | 'fader' | 'layout'): void {
  prepareMa2ExecutorPages();
  useMa2ExecutorPageStore.setState(state => kind === 'layout' ? { kind } : { kind, slot: null, error: '', page: state.selectedPages[kind] ?? (kind === 'button' ? state.directory?.buttonPage : state.directory?.faderPage) ?? 1, navigation: state.navigation + 1 });
}
export async function loadMa2ExecutorDirectory(): Promise<Ma2ExecutorPageDirectory> {
  const scope = prepareMa2ExecutorPages();
  const directory = ma2ExecutorPageDirectorySchema.parse(await window.tbLink.listMa2ExecutorPages(await ma2LayoutConnection()));
  if (scope !== currentMa2LayoutScope()) throw new Error('工程或控台已切换');
  useMa2ExecutorPageStore.setState(state => {
    const changed = state.directory && JSON.stringify(state.directory.pages) !== JSON.stringify(directory.pages);
    return { directory, bandPages: { upper: state.bandPages.upper ?? directory.buttonPage, fader: state.bandPages.fader ?? directory.faderPage, lower: state.bandPages.lower ?? directory.faderPage }, ...(changed ? { complete: false, pages: Object.fromEntries(Object.entries(state.pages).filter(([page]) => directory.pages.some(entry => entry.page === Number(page)))) } : {}) };
  });
  return directory;
}
let mutationEpoch = 0;
const pendingPages = new Map<string, Promise<Ma2ExecutorPage>>();
export async function loadMa2ExecutorPage(page: number, background = false): Promise<Ma2ExecutorPage> {
  if (!Number.isInteger(page) || page < 1 || page > 9999) throw new Error('请输入 1–9999 的页码');
  const key = `${prepareMa2ExecutorPages()}:${page}`;
  const pending = pendingPages.get(key);
  if (pending) return pending;
  const task = readPage(page, background);
  pendingPages.set(key, task);
  try { return await task; } finally { if (pendingPages.get(key) === task) pendingPages.delete(key); }
}
async function readPage(page: number, background: boolean): Promise<Ma2ExecutorPage> {
  const scope = prepareMa2ExecutorPages(); const requestId = crypto.randomUUID(); const epoch = mutationEpoch;
  if (!background) useMa2ExecutorPageStore.setState(state => ({ page, busy: true, error: '', requestId, selectedPages: state.kind === 'layout' ? state.selectedPages : { ...state.selectedPages, [state.kind]: page } }));
  try {
    const snapshot = ma2ExecutorPageSchema.parse(await window.tbLink.readMa2ExecutorPage({ ...await ma2LayoutConnection(), page }));
    if (snapshot.page !== page || scope !== currentMa2LayoutScope()) throw new Error('页面已经变了，这次的结果没有采用');
    if (epoch !== mutationEpoch) return snapshot;
    mergePageMetadata(snapshot);
    useMa2ExecutorPageStore.setState(state => ({ pages: { ...state.pages, [page]: snapshot }, pageErrors: { ...state.pageErrors, [page]: '' }, ...(!background && state.requestId === requestId ? { busy: false, requestId: null } : {}) }));
    return snapshot;
  } catch (cause) {
    if (scope === currentMa2LayoutScope() && epoch === mutationEpoch) useMa2ExecutorPageStore.setState(state => ({ complete: false, pageErrors: { ...state.pageErrors, [page]: cause instanceof Error ? cause.message : String(cause) }, ...(!background && state.requestId === requestId ? { error: cause instanceof Error ? cause.message : String(cause) } : {}) }));
    throw cause;
  } finally {
    if (!background && scope === currentMa2LayoutScope() && useMa2ExecutorPageStore.getState().requestId === requestId) useMa2ExecutorPageStore.setState({ busy: false, requestId: null });
  }
}
function mergePageMetadata(snapshot: Ma2ExecutorPage): void {
    const document = useDocumentStore.getState(); const material = document.project?.ma2MaterialLibrary;
    if (snapshot.sequences.length && material?.library) {
      const numbers = new Set(snapshot.sequences.map(value => value.sequence));
      const previous = material.library.sequences.filter(value => numbers.has(value.sequence)).sort((a, b) => a.sequence - b.sequence);
      const incoming = [...snapshot.sequences].sort((a, b) => a.sequence - b.sequence);
      if (JSON.stringify(previous) !== JSON.stringify(incoming)) document.executeForDocument(document.documentId, mergeMa2MetadataCommand(material.source, {
        directory: { ...material.library.directory, entries: [...material.library.directory.entries.filter(value => !numbers.has(value.target)), ...snapshot.sequences.map(value => ({ target: value.sequence, name: value.name ?? '' }))].sort((a, b) => a.target - b.target) },
        sequences: snapshot.sequences, readAt: snapshot.readAt, errors: [], fixtureUsage: []
      }));
    }
}
export async function updateMa2ExecutorPageItem(page: number, item: Ma2ExecutorPage['items'][number], action: Ma2ExecutorUpdateRequest['action']): Promise<void> {
  const scope = prepareMa2ExecutorPages();
  const before = useDocumentStore.getState();
  if (useMa2ExecutorPageStore.getState().mutating) throw new Error('正在确认上一次的位置修改，请稍候');
  const address = `${page}.${item.slot}`;
  if (action.kind === 'move' && action.page === page && action.slot === item.slot) return;
  if (action.kind === 'delete' && before.project) {
    const uses = ma2ExecutorDeletionUses(before.project, address);
    if (uses.length) throw new Error(uses.join('；'));
  }
  mutationEpoch += 1;
  useMa2ExecutorPageStore.setState({ mutating: true, error: '' });
  try {
    const connection = await ma2LayoutConnection();
    if (scope !== currentMa2LayoutScope() || useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程或控台已切换，执行器没有修改');
    if (action.kind === 'delete') {
      const project = useDocumentStore.getState().project;
      const uses = project ? ma2ExecutorDeletionUses(project, address) : [];
      if (uses.length) throw new Error(uses.join('；'));
    }
    const result = ma2ExecutorUpdateResultSchema.parse(await window.tbLink.updateMa2Executor({ ...connection, page, slot: item.slot, expectedItem: item, action }));
    const currentScope = currentMa2LayoutScope();
    const refreshed = scope !== currentScope;
    if (useDocumentStore.getState().documentId !== before.documentId || refreshed && executorScopeIdentity(scope) !== executorScopeIdentity(currentScope)) {
      const written = action.kind === 'move' ? `${address} → ${action.page}.${action.slot}` : action.kind === 'delete' ? `${address} 已清空` : `${address} 已重命名为“${action.name}”`;
      throw new Error(`已写入控台 ${connection.network.host}:${connection.network.port} / ${connection.expectedSource.show} 并确认：${written}。但工程或控台已经切换，本地没有应用这次结果。请回到原来的工程和控台，读取对应页面，检查时间线里引用的执行器。备份：${result.backupFile}`);
    }
    // A bridge restart does not undo a confirmed native write. Rebase the same
    // document, but never merge snapshots read under the previous generation.
    if (refreshed) prepareMa2ExecutorPages();
    if (action.kind !== 'rename') before.executeForDocument(before.documentId, applyMa2ExecutorChangeCommand(`${connection.network.host}:${connection.network.port}`, connection.expectedSource.show, item.sequence, address, action.kind === 'move' ? `${action.page}.${action.slot}` : null));
    if (!refreshed) {
      useMa2ExecutorPageStore.setState(state => ({ pages: { ...state.pages, ...Object.fromEntries(result.pages.map(value => [value.page, value])) }, pageErrors: { ...state.pageErrors, ...Object.fromEntries(result.pages.map(value => [value.page, ''])) } }));
      for (const value of result.pages) mergePageMetadata(value);
    }
    if (action.kind === 'delete') {
      const project = useDocumentStore.getState().project;
      const uses = project ? ma2ExecutorDeletionUses(project, address) : [];
      if (uses.length) throw new Error(`控台 ${address} 已清空；写入过程中新加的执行器动作已保留，请重新指定目标：${uses.join('；')}`);
    }
  } catch (cause) {
    if (scope === currentMa2LayoutScope()) useMa2ExecutorPageStore.setState({ error: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  } finally { mutationEpoch += 1; if (scope === currentMa2LayoutScope()) useMa2ExecutorPageStore.setState({ mutating: false }); }
}
/** A complete pass is required before claiming that a Sequence is absent from every executor page. */
export async function scanMa2ExecutorLocations(): Promise<void> {
  const scope = prepareMa2ExecutorPages();
  const epoch = mutationEpoch;
  if (useMa2ExecutorPageStore.getState().scanning) return;
  useMa2ExecutorPageStore.setState({ scanning: true, complete: false, completed: 0, total: 0, error: '' });
  try {
    const directory = await loadMa2ExecutorDirectory();
    useMa2ExecutorPageStore.setState(state => ({ total: directory.pages.length, pages: Object.fromEntries(Object.entries(state.pages).filter(([number]) => directory.pages.some(page => page.page === Number(number)))) }));
    for (const [index, entry] of directory.pages.entries()) {
      if (scope !== currentMa2LayoutScope()) return;
      await loadMa2ExecutorPage(entry.page, true);
      if (epoch !== mutationEpoch) throw new Error('读取位置时执行器被修改了，请重新读取全部位置');
      useMa2ExecutorPageStore.setState({ completed: index + 1 });
    }
    const verified = await loadMa2ExecutorDirectory();
    if (epoch !== mutationEpoch) throw new Error('读取位置时执行器被修改了，请重新读取全部位置');
    if (JSON.stringify(verified.pages) !== JSON.stringify(directory.pages)) throw new Error('读取时控台页面有变化，请刷新位置');
    useMa2ExecutorPageStore.setState({ complete: true });
  } catch (cause) {
    if (scope === currentMa2LayoutScope()) useMa2ExecutorPageStore.setState({ error: cause instanceof Error ? cause.message : String(cause) });
    throw cause;
  } finally { if (scope === currentMa2LayoutScope()) useMa2ExecutorPageStore.setState({ scanning: false }); }
}
const locationCache = new WeakMap<Record<number, Ma2ExecutorPage>, Map<number, Array<{ page: number; slot: number }>>>();
export function ma2SequenceLocations(pages: Record<number, Ma2ExecutorPage>, sequence: number): Array<{ page: number; slot: number }> {
  let index = locationCache.get(pages);
  if (!index) {
    index = new Map();
    for (const page of Object.values(pages).sort((a, b) => a.page - b.page)) for (const item of page.items) if (item.sequence) index.set(item.sequence, [...index.get(item.sequence) ?? [], { page: page.page, slot: item.slot }]);
    locationCache.set(pages, index);
  }
  return index.get(sequence) ?? [];
}
export function ma2ExecutorLocationLabel(page: number, slot: number): string { return `${slot >= 101 ? '按钮' : '推杆'}第 ${page} 页 · ${slot} 格`; }
