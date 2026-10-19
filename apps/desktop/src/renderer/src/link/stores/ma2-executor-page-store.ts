import { create } from 'zustand';
import { ma2ExecutorPageSchema, ma2ExecutorPageDirectorySchema, type Ma2ExecutorPage, type Ma2ExecutorPageDirectory } from '@tb/schema';
import { currentMa2LayoutScope, ma2LayoutConnection } from './ma2-layout-store';
import { mergeMa2MetadataCommand } from '@tb/core/link';
import { useDocumentStore } from './document-store';

type PageState = { scope: string; kind: 'button' | 'fader' | 'layout'; page: number; selectedPages: { button: number | null; fader: number | null }; slot: number | null; navigation: number; directory: Ma2ExecutorPageDirectory | null; pages: Record<number, Ma2ExecutorPage>; busy: boolean; scanning: boolean; completed: number; total: number; complete: boolean; error: string; requestId: string | null };
const initial = (): Omit<PageState, 'scope' | 'navigation'> => ({ kind: 'button', page: 1, selectedPages: { button: null, fader: null }, slot: null, directory: null, pages: {}, busy: false, scanning: false, completed: 0, total: 0, complete: false, error: '', requestId: null });
export const useMa2ExecutorPageStore = create<PageState>(() => ({ ...initial(), scope: '', navigation: 0 }));
export function prepareMa2ExecutorPages(): string {
  const scope = currentMa2LayoutScope();
  if (useMa2ExecutorPageStore.getState().scope !== scope) useMa2ExecutorPageStore.setState({ ...initial(), scope, navigation: 0 });
  return scope;
}
export function locateMa2Executor(page: number, slot: number): void {
  prepareMa2ExecutorPages();
  const kind = slot >= 101 ? 'button' : 'fader';
  useMa2ExecutorPageStore.setState(state => ({ kind, page, slot, selectedPages: { ...state.selectedPages, [kind]: page }, navigation: state.navigation + 1 }));
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
    return { directory, ...(changed ? { complete: false, pages: Object.fromEntries(Object.entries(state.pages).filter(([page]) => directory.pages.some(entry => entry.page === Number(page)))) } : {}) };
  });
  return directory;
}
export async function loadMa2ExecutorPage(page: number, background = false): Promise<Ma2ExecutorPage> {
  if (!Number.isInteger(page) || page < 1 || page > 9999) throw new Error('请输入 1–9999 的页码');
  const scope = prepareMa2ExecutorPages(); const requestId = crypto.randomUUID();
  if (!background) useMa2ExecutorPageStore.setState(state => ({ page, busy: true, error: '', requestId, selectedPages: state.kind === 'layout' ? state.selectedPages : { ...state.selectedPages, [state.kind]: page } }));
  try {
    const snapshot = ma2ExecutorPageSchema.parse(await window.tbLink.readMa2ExecutorPage({ ...await ma2LayoutConnection(), page }));
    if (snapshot.page !== page || scope !== currentMa2LayoutScope()) throw new Error('页面来源已变化，本次结果未采用');
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
    useMa2ExecutorPageStore.setState(state => ({ pages: { ...state.pages, [page]: snapshot }, ...(!background && state.requestId === requestId ? { busy: false, requestId: null } : {}) }));
    return snapshot;
  } catch (cause) {
    if (scope === currentMa2LayoutScope()) useMa2ExecutorPageStore.setState(state => ({ complete: false, pages: Object.fromEntries(Object.entries(state.pages).filter(([number]) => Number(number) !== page)), ...(!background && state.requestId === requestId ? { busy: false, requestId: null, error: cause instanceof Error ? cause.message : String(cause) } : {}) }));
    throw cause;
  }
}
/** A complete pass is required before claiming that a Sequence is absent from every executor page. */
export async function scanMa2ExecutorLocations(): Promise<void> {
  const scope = prepareMa2ExecutorPages();
  if (useMa2ExecutorPageStore.getState().scanning) return;
  useMa2ExecutorPageStore.setState({ scanning: true, complete: false, completed: 0, total: 0, error: '' });
  try {
    const directory = await loadMa2ExecutorDirectory();
    useMa2ExecutorPageStore.setState(state => ({ total: directory.pages.length, pages: Object.fromEntries(Object.entries(state.pages).filter(([number]) => directory.pages.some(page => page.page === Number(number)))) }));
    for (const [index, entry] of directory.pages.entries()) {
      if (scope !== currentMa2LayoutScope()) return;
      await loadMa2ExecutorPage(entry.page, true);
      useMa2ExecutorPageStore.setState({ completed: index + 1 });
    }
    const verified = await loadMa2ExecutorDirectory();
    if (JSON.stringify(verified.pages) !== JSON.stringify(directory.pages)) throw new Error('控台页面目录在读取期间改变，请刷新位置');
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
