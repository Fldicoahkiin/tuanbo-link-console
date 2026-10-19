import { create } from 'zustand';
import { applyMa2SongReadback, ma2SongPoints, mergeMa2AttributesCommand, projectLightingLibrary, setLightingLibraryCommand, setLightingCommand } from '@tb/core/link';
import type { Ma2LayoutSettings } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { acceptCreatedMa2Layout, currentMa2LayoutScope } from '../stores/ma2-layout-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { locateMa2Executor, ma2ExecutorLocationLabel, loadMa2ExecutorPage } from '../stores/ma2-executor-page-store';

type SongSync = { itemId: string; documentId: number; name: string; settings: Ma2LayoutSettings; state: 'pending' | 'syncing' | 'verified' | 'blocked'; message: string; checking?: boolean; acknowledged?: string; confirmedDeletions?: string[] };
export const useMa2SongSyncStore = create<{ songs: Record<string, SongSync> }>(() => ({ songs: {} }));
let running = false;
export function startMa2SongSync(itemId: string, name: string, settings: Ma2LayoutSettings, confirmedDeletions?: string[]): void {
  const documentId = useDocumentStore.getState().documentId;
  useMa2SongSyncStore.setState(state => ({ songs: { ...state.songs, [itemId]: { itemId, documentId, name, settings, state: 'pending', message: '等待停止播放后同步', ...(confirmedDeletions ? { confirmedDeletions } : {}) } } }));
}
export function stopMa2SongSync(itemId: string): void { useMa2SongSyncStore.setState(state => ({ songs: Object.fromEntries(Object.entries(state.songs).filter(([id]) => id !== itemId)) })); }
function update(entry: SongSync, patch: Partial<SongSync>): void {
  useMa2SongSyncStore.setState(state => state.songs[entry.itemId]?.documentId !== entry.documentId ? state : { songs: { ...state.songs, [entry.itemId]: { ...state.songs[entry.itemId]!, ...patch } } });
}

/** Serialized, explicit opt-in. A failure blocks this song until the user requests another check. */
export async function tickMa2SongSync(playing: boolean): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const entry of Object.values(useMa2SongSyncStore.getState().songs)) {
      if (entry.documentId !== useDocumentStore.getState().documentId) { stopMa2SongSync(entry.itemId); continue; }
      if (entry.state === 'blocked') continue;
      if (playing) { update(entry, { state: 'pending', message: '播放中，修改将在停止后同步' }); continue; }
      try {
        const before = useDocumentStore.getState(); const item = before.project?.rundown.find(value => value.id === entry.itemId);
        if (!before.project || !item?.lighting) throw new Error('本曲已不存在');
        if (item.lighting.outputMode !== 'network') throw new Error('歌曲序列播放需要网络直控，请先切换灯光输出');
        if (item.lighting.ma2Bindings?.length) throw new Error('本曲已有控台时间码绑定；请在未绑定的新曲创建歌曲序列，避免改变现有控台编排');
        const points = ma2SongPoints(item.lighting); if (!points.length) throw new Error('请先在时间线添加 Cue；清空整曲请先核对控台删除清单');
        const materials = before.project.ma2MaterialLibrary;
        if (!materials?.library || materials.library.sourceUnverified) throw new Error('请先读取并核对控台素材');
        const signature = JSON.stringify([points, item.lighting.consoleSong?.name ?? entry.name]);
        update(entry, entry.state === 'verified' && entry.acknowledged === signature ? { checking: true } : { checking: true, state: 'syncing', message: `核对本曲 ${points.length} 个 Cue…` });
        const connection = await ma2MaterialConnection();
        if (!connection.network) throw new Error('歌曲同步需要 MA2 网络连接');
        const endpoint = `${connection.network.host}:${connection.network.port}`;
        if (endpoint !== materials.source) throw new Error('素材来源与当前控台不一致');
        const path = before.path ?? await linkDesktopViewModel.saveProject(null, before.project);
        if (!path) throw new Error('请先保存工程');
        if (useDocumentStore.getState().documentId !== entry.documentId || !useMa2SongSyncStore.getState().songs[entry.itemId]) continue;
        const { show, generation, version } = materials.library.directory;
        const scope = currentMa2LayoutScope();
        const result = await window.tbLink.syncMa2Song({ network: connection.network, expectedSource: { show, generation, version }, projectId: before.project.projectId, itemId: item.id,
          requestId: crypto.randomUUID(), settings: entry.settings, name: item.lighting.consoleSong?.name ?? entry.name, points,
          ...(item.lighting.consoleSong ? { binding: item.lighting.consoleSong } : {}), ...(entry.confirmedDeletions ? { confirmedDeletions: entry.confirmedDeletions } : {}) });
        const after = useDocumentStore.getState();
        if (after.documentId !== entry.documentId) throw new Error('控台操作已完成但工程已切换，请回到原工程核对');
        const current = after.project?.rundown.find(value => value.id === entry.itemId)?.lighting;
        if (!current || !after.project) throw new Error('歌曲已移除，控台结果保留，请读取核对');
        if (JSON.stringify(current.consoleSong) !== JSON.stringify(result.binding)) {
          after.executeForDocument(entry.documentId, { id: crypto.randomUUID(), label: '同步歌曲控台序列', scope: 'lighting', historyRebaseKey: `ma2-song:${entry.itemId}`, rebaseHistory: project => ({
            ...project, rundown: project.rundown.map(value => value.id !== entry.itemId || !value.lighting ? value : { ...value, lighting: { ...value.lighting, consoleSong: result.binding } })
          }), execute(project) {
            const lighting = project.rundown.find(value => value.id === entry.itemId)?.lighting;
            if (!lighting) throw new Error('歌曲已不存在');
            const merged = mergeMa2AttributesCommand(endpoint, result.library, [result.binding.sequence], false).execute(project);
            const acknowledged = applyMa2SongReadback(lighting, points, result);
            if (lighting.consoleSong && lighting.consoleSong.name !== item.lighting?.consoleSong?.name) acknowledged.consoleSong = { ...result.binding, name: lighting.consoleSong.name };
            const updated = setLightingCommand(entry.itemId, acknowledged, '回读歌曲 Cue').execute(merged);
            return setLightingLibraryCommand({ ...projectLightingLibrary(updated), consoleWorkspace: { ...entry.settings, nextSequence: Math.min(99999, result.binding.sequence + 1) } }).execute(updated);
          }, undo: before => before });
          const saved = useDocumentStore.getState(); if (!saved.project) throw new Error('工程已关闭');
          const savedPath = await linkDesktopViewModel.saveProject(path, saved.project);
          if (!savedPath) throw new Error('控台已同步，工程保存未完成');
          saved.markSaved(savedPath, saved.revision, entry.documentId);
        }
        if (result.layout) acceptCreatedMa2Layout(scope, result.layout, !item.lighting.consoleSong);
        if (result.binding.executor && !item.lighting.consoleSong) {
          const [page, slot] = result.binding.executor.split('.').map(Number);
          locateMa2Executor(page!, slot!); await loadMa2ExecutorPage(page!);
        }
        const confirmed = applyMa2SongReadback(item.lighting, points, result);
        const location = result.binding.executor ? ma2ExecutorLocationLabel(Number(result.binding.executor.split('.')[0]), Number(result.binding.executor.split('.')[1])) : `Layout ${result.binding.layout}`;
        update(entry, { state: 'verified', checking: false, acknowledged: JSON.stringify([ma2SongPoints(confirmed), result.binding.name]), message: `${location} · 序列 ${result.binding.sequence} · ${result.binding.points.length} 步已回读`, confirmedDeletions: [] });
      } catch (cause) { update(entry, { state: 'blocked', checking: false, message: cause instanceof Error ? cause.message : String(cause) }); }
    }
  } finally { running = false; }
}
