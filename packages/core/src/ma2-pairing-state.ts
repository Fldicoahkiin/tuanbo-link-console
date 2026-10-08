import { parseLinkProject, type LinkProject, type Ma2Catalog, type Ma2ReadState } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { matchMa2Programs } from './ma2-program-matching';
import { programTimeOrigin } from './ma2-time-origin';
import { importMa2TimecodeCommand } from './ma2-import';

export function ma2PairingEvidence(project: LinkProject, source: string, catalog: Ma2Catalog, target: number, itemId: string): string {
  const item = project.rundown.find(value => value.id === itemId);
  const entry = catalog.entries.find(value => value.target === target);
  if (!item?.referenceAudio || !entry || entry.error || item.p1UnavailableSourceKey || item.p1Media?.importedFullSource || !item.p1Media && !item.playback) return '';
  try {
    return JSON.stringify({ source, show: catalog.directory.show, version: catalog.directory.version, generation: catalog.directory.generation,
      frame: entry.frameFormat, offset: entry.offset, times: entry.events.map(event => event.time),
      origin: programTimeOrigin(item),
      audio: item.referenceAudio.sha256, duration: item.referenceAudio.durationMs, trim: item.p1Media?.sourceTrim,
      fullSource: item.p1Media?.importedFullSource });
  } catch { return ''; }
}

/** Legacy automatic suggestions never become operator confirmations on a new scan. */
export function reconcileMa2ReadState(project: LinkProject, source: string, catalog: Ma2Catalog): Ma2ReadState {
  const previous = project.ma2ReadState;
  const matched = matchMa2Programs(project, catalog);
  const pairings: NonNullable<Ma2ReadState['pairings']> = {};
  for (const entry of catalog.entries) {
    const key = String(entry.target);
    const bound = project.rundown.find(item => item.lighting?.ma2Bindings?.some(binding => binding.timecode === entry.target));
    const old = previous?.pairings?.[key];
    const itemId = bound?.id ?? (old?.status === 'confirmed' || old?.status === 'stale' ? old.itemId : matched.pairs[entry.target]);
    if (!itemId) continue;
    const evidence = ma2PairingEvidence(project, source, catalog, entry.target, itemId);
    const sameSource = previous?.source === source && previous.catalog.directory.show === catalog.directory.show;
    const confirmed = old?.status === 'confirmed' && sameSource && evidence !== '' && old.evidence === evidence;
    const retained = Boolean(bound || old?.status === 'confirmed' || old?.status === 'stale');
    pairings[key] = { itemId, evidence, status: confirmed ? 'confirmed' : retained ? 'stale' : 'suggested',
      ...(retained && !confirmed ? { reason: '来源或时间依据需要重新核对；已有灯光与本地编辑保留' } : {}) };
  }
  for (const item of project.rundown) for (const binding of item.lighting?.ma2Bindings ?? []) {
    const key = String(binding.timecode);
    if (!pairings[key]) pairings[key] = { itemId: item.id, evidence: '', status: 'stale', reason: '新目录中未取得此时间线，已有灯光保留；请核对控台来源' };
  }
  const sameSource = previous?.source === source && previous.catalog.directory.show === catalog.directory.show && previous.catalog.directory.generation === catalog.directory.generation;
  return { formatVersion: 2, source, catalog, pairings, ...(previous?.detachedBindings ? { detachedBindings: previous.detachedBindings } : {}),
    pairs: Object.fromEntries(Object.entries(pairings).filter(([, value]) => value.status !== 'stale').map(([key, value]) => [key, value.itemId])),
    failures: sameSource ? previous.failures : [], selectedTarget: previous?.selectedTarget ?? null,
    query: previous?.query ?? '', filter: previous?.filter ?? 'all',
    message: `${catalog.entries.filter(entry => !entry.error).length} 条已读取 · ${catalog.entries.filter(entry => entry.error).length} 条读取异常${catalog.incomplete ? ' · 尚未完成' : ''}` };
}

/** Preserve the complete native baseline and local edits outside the active playback document. */
export function detachMa2BindingCommand(itemId: string, target: number): LinkCommand {
  return { id: crypto.randomUUID(), label: '解除控台关联并归档本地编排', execute(project) {
    const next = structuredClone(project);
    const state = next.ma2ReadState;
    const lighting = next.rundown.find(item => item.id === itemId)?.lighting;
    const binding = lighting?.ma2Bindings?.find(value => value.timecode === target);
    if (!state || !lighting || !binding) throw new Error('关联已不存在');
    const ids = new Set([...binding.baselineTracks.map(track => track.id), ...(binding.pendingTracks ?? []).map(track => track.trackId)]);
    state.detachedBindings = [...state.detachedBindings ?? [], { itemId, detachedAt: new Date().toISOString(), binding, tracks: lighting.tracks.filter(track => ids.has(track.id)) }];
    state.formatVersion = 2;
    lighting.tracks = lighting.tracks.filter(track => !ids.has(track.id));
    lighting.ma2Bindings = lighting.ma2Bindings?.filter(value => value.id !== binding.id);
    delete state.pairs[target];
    if (state.pairings) delete state.pairings[target];
    return parseLinkProject({ ...next, updatedAt: new Date().toISOString() });
  }, undo: before => parseLinkProject(before) };
}

export function restoreMa2BindingCommand(itemId: string, target: number): LinkCommand {
  return { id: crypto.randomUUID(), label: '恢复归档的灯光关联和本地编辑', execute(project) {
    const next = structuredClone(project);
    const state = next.ma2ReadState;
    const item = next.rundown.find(value => value.id === itemId);
    const archived = state?.detachedBindings?.slice().reverse().find(value => value.itemId === itemId && value.binding.timecode === target);
    if (!state || !item?.lighting || !archived) throw new Error('没有可恢复的本地编排');
    if (next.rundown.some(song => song.lighting?.ma2Bindings?.some(value => value.timecode === target))) throw new Error('此时间线已关联歌曲，请先解除当前关联');
    item.lighting.tracks.push(...archived.tracks);
    item.lighting.ma2Bindings = [...item.lighting.ma2Bindings ?? [], archived.binding];
    if (archived.binding.nativeEvents?.length) item.lighting.outputMode = 'timecode';
    state.detachedBindings = state.detachedBindings?.filter(value => value !== archived);
    next.ma2ReadState = reconcileMa2ReadState(next, state.source, state.catalog);
    return parseLinkProject({ ...next, updatedAt: new Date().toISOString() });
  }, undo: before => parseLinkProject(before) };
}

export function refreshMa2BindingCommand(itemId: string, target: number, archiveLocalEdits = false): LinkCommand {
  return { id: crypto.randomUUID(), label: '从工程缓存刷新已绑定灯光', execute(project) {
    const state = project.ma2ReadState;
    const entry = state?.catalog.entries.find(value => value.target === target);
    const lighting = project.rundown.find(item => item.id === itemId)?.lighting;
    const binding = lighting?.ma2Bindings?.find(value => value.timecode === target);
    if (!state || !entry?.preview || entry.error || !binding || !lighting) throw new Error('此时间线没有完整的已读内容');
    if (state.catalog.sourceUnverified) throw new Error('读取来源发生变化，请重新核对后刷新');
    const ids = new Set(binding.baselineTracks.map(track => track.id));
    const tracks = lighting.tracks.filter(track => ids.has(track.id));
    if (!archiveLocalEdits && (binding.pendingTracks?.length || JSON.stringify(tracks) !== JSON.stringify(binding.baselineTracks))) throw new Error('本地编排已有修改：请选择保留本地，或归档本地后采用控台版本');
    const archived = detachMa2BindingCommand(itemId, target).execute(project);
    const replaced = importMa2TimecodeCommand(itemId, entry.preview).execute(archived);
    return confirmMa2PairingCommand(target, itemId).execute(replaced);
  }, undo: before => parseLinkProject(before) };
}

/** Run inside the same command as an edit so undo restores both timing and confirmation. */
export function withMa2PairingValidation(command: LinkCommand): LinkCommand {
  return { ...command, execute(project) {
    const next = command.execute(project);
    const state = next.ma2ReadState;
    if (!state?.pairings) return next;
    const invalid = Object.entries(state.pairings).filter(([target, value]) => value.status !== 'stale' && value.evidence !== ma2PairingEvidence(next, state.source, state.catalog, Number(target), value.itemId));
    if (!invalid.length) return next;
    const pairs = { ...state.pairs }, pairings = { ...state.pairings };
    for (const [target, value] of invalid) { delete pairs[target]; pairings[target] = { ...value, status: 'stale', reason: '歌曲起点或音频范围已修改，请重新核对配对' }; }
    return parseLinkProject({ ...next, ma2ReadState: { ...state, pairs, pairings } });
  } };
}

export function confirmMa2PairingCommand(target: number, itemId: string): LinkCommand {
  return { id: crypto.randomUUID(), label: '确认歌曲与控台时间线对应关系', execute(project) {
    const state = project.ma2ReadState;
    if (!state) throw new Error('尚无控台缓存');
    if (state.catalog.sourceUnverified) throw new Error('控台来源尚未核对，请先复核读取来源');
    const song = project.rundown.find(item => item.id === itemId);
    const entry = state.catalog.entries.find(item => item.target === target);
    const origin = song && (song.p1Media || song.playback) ? programTimeOrigin(song) : undefined;
    if (!entry || origin === undefined || !song?.referenceAudio || entry.frameFormat !== '30 FPS' || !/^\d+(?:\.\d+)?$/.test(entry.offset ?? '0') || !entry.events.length || entry.events.some(event => !/^\d+(?:\.\d+)?$/.test(event.time) || (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30 < origin || (Number(event.time) + Number(entry.offset ?? 0)) * 1000 / 30 >= origin + song.referenceAudio!.durationMs)) throw new Error('时间格式或歌曲范围尚未核对，不能确认配对');
    const binding = song.lighting?.ma2Bindings?.find(value => value.timecode === target);
    if (binding && (binding.timeOriginMs ?? 0) !== origin) throw new Error('绑定中的歌曲起点已经变化，请先刷新并核对本地 Cue 位置');
    const evidence = ma2PairingEvidence(project, state.source, state.catalog, target, itemId);
    if (!evidence) throw new Error('歌曲起点或控台数据无效，无法确认配对');
    return parseLinkProject({ ...project, schemaVersion: 2, updatedAt: new Date().toISOString(), ma2ReadState: { ...state, formatVersion: 2,
      pairs: { ...state.pairs, [target]: itemId }, pairings: { ...state.pairings, [target]: { itemId, status: 'confirmed', evidence } } } });
  }, undo: before => parseLinkProject(before) };
}
