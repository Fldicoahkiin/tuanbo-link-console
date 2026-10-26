import { create } from 'zustand';
import { projectLightingLibrary, mergeMa2MetadataCommand } from '@tb/core/link';
import { ma2EffectLibrarySchema, ma2LayoutSnapshotSchema, type Ma2LayoutSnapshot, type LinkProject } from '@tb/schema';
import { useDocumentStore } from './document-store';
import { ma2MaterialConnection } from './ma2-material-read-store';

type LayoutPageState = {
  scope: string;
  page: number;
  snapshot: Ma2LayoutSnapshot | null;
  busy: boolean;
  error: string;
  requestId: string | null;
};

export const useMa2LayoutStore = create<LayoutPageState>(() => ({ scope: '', page: 999, snapshot: null, busy: false, error: '', requestId: null }));

function layoutScope(documentId: number, project: LinkProject | null): string {
  const pool = project?.ma2MaterialLibrary;
  const directory = pool?.library?.directory;
  return JSON.stringify([documentId, pool?.source, directory?.show, directory?.generation, directory?.version, pool?.library?.sourceUnverified]);
}

export function currentMa2LayoutScope(): string {
  const state = useDocumentStore.getState();
  return layoutScope(state.documentId, state.project);
}

export function useMa2LayoutPage(): LayoutPageState {
  const documentId = useDocumentStore(state => state.documentId);
  const project = useDocumentStore(state => state.project);
  const state = useMa2LayoutStore();
  const scope = layoutScope(documentId, project);
  if (state.scope === scope) return state;
  return { scope, page: project ? projectLightingLibrary(project).consoleWorkspace?.layout ?? 999 : 999, snapshot: null, busy: false, error: '', requestId: null };
}

/** Read-only navigation. It never changes the destination used to create new Cue objects. */
export async function readMa2LayoutPage(page: number, refresh = false): Promise<Ma2LayoutSnapshot> {
  if (!Number.isInteger(page) || page < 1 || page > 9999) throw new Error('页面编号需要为 1–9999 的整数');
  const scope = currentMa2LayoutScope();
  const previous = useMa2LayoutStore.getState();
  if (previous.scope === scope && previous.busy) throw new Error('正在读取控台页面，请稍候');
  const before = useDocumentStore.getState();
  const pool = before.project?.ma2MaterialLibrary;
  const requestId = crypto.randomUUID();
  useMa2LayoutStore.setState({ scope, page, snapshot: refresh && previous.scope === scope && previous.page === page ? previous.snapshot : null, busy: true, error: '', requestId });
  try {
    if (!pool?.library || pool.library.sourceUnverified) throw new Error('请先读取控台素材');
    const connection = await ma2MaterialConnection();
    if (!connection.network) throw new Error('控台页面需要通过网络连接 MA2，请先在设备设置里连接控台 IP');
    if (`${connection.network.host}:${connection.network.port}` !== pool.source) throw new Error('当前连接的控台和素材来源不是同一台，请重新读取控台');
    if (currentMa2LayoutScope() !== scope) throw new Error('工程或素材来源变了，请重新读取页面');
    const { show, generation, version } = pool.library.directory;
    const snapshot = ma2LayoutSnapshotSchema.parse(await window.tbLink.readMa2Layout({ network: connection.network, expectedSource: { show, generation, version }, layout: page }));
    if (snapshot.layout !== page) throw new Error('控台返回的页面编号不一致');
    const targets = [...new Set(snapshot.items.flatMap(item => item.sequence ?? []))];
    if (targets.length) {
      const metadata = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary({ ...connection, targets, expectedSource: { show, generation, version } }));
      if (currentMa2LayoutScope() !== scope) throw new Error('工程或素材来源变了');
      const current = useDocumentStore.getState();
      if (JSON.stringify(metadata.sequences) !== JSON.stringify(current.project?.ma2MaterialLibrary?.library?.sequences.filter(sequence => targets.includes(sequence.sequence)))) current.executeForDocument(before.documentId, mergeMa2MetadataCommand(pool.source, metadata));
    }
    if (currentMa2LayoutScope() !== scope || useMa2LayoutStore.getState().requestId !== requestId) throw new Error('工程或素材来源变了，旧页面不再显示');
    const content = (value: Ma2LayoutSnapshot | null): string => JSON.stringify(value ? { ...value, readAt: '' } : null);
    useMa2LayoutStore.setState({ snapshot: content(previous.snapshot) === content(snapshot) ? previous.snapshot : snapshot, busy: false, requestId: null });
    return snapshot;
  } catch (cause) {
    if (useMa2LayoutStore.getState().requestId === requestId) useMa2LayoutStore.setState({ snapshot: null, busy: false, error: cause instanceof Error ? cause.message : String(cause), requestId: null });
    throw cause;
  }
}

export function acceptCreatedMa2Layout(scope: string, snapshot: Ma2LayoutSnapshot, navigate = true): void {
  if (scope !== currentMa2LayoutScope()) throw new Error('控台上已创建，但工程或素材来源变了，请重新读取页面');
  const current = useMa2LayoutStore.getState();
  if (!navigate && (current.scope !== scope || current.page !== snapshot.layout || current.busy)) return;
  useMa2LayoutStore.setState({ scope, page: snapshot.layout, snapshot, busy: false, error: '', requestId: null });
}

export async function ma2LayoutConnection() {
  const pool = useDocumentStore.getState().project?.ma2MaterialLibrary;
  if (!pool?.library || pool.library.sourceUnverified) throw new Error('请先读取控台素材');
  const connection = await ma2MaterialConnection();
  if (!connection.network || `${connection.network.host}:${connection.network.port}` !== pool.source) throw new Error('当前连接的控台和素材来源不是同一台');
  const { show, generation, version } = pool.library.directory;
  return { network: connection.network, expectedSource: { show, generation, version } };
}
export async function updateMa2LayoutPage(change: { positions: import('@tb/schema').Ma2LayoutUpdateRequest['positions']; name?: string }): Promise<void> {
  const before = useMa2LayoutStore.getState(); const scope = currentMa2LayoutScope();
  if (before.scope !== scope || !before.snapshot?.revision || before.busy) throw new Error('请先刷新本页再编辑');
  useMa2LayoutStore.setState({ busy: true, error: '' });
  try {
    const result = await window.tbLink.updateMa2Layout({ ...await ma2LayoutConnection(), layout: before.page, revision: before.snapshot.revision, ...change });
    if (scope !== currentMa2LayoutScope()) throw new Error('控台上已修改，但工程变了，请重新读取');
    useMa2LayoutStore.setState({ snapshot: result, busy: false });
  } catch (cause) { useMa2LayoutStore.setState({ busy: false, error: cause instanceof Error ? cause.message : String(cause) }); throw cause; }
}
