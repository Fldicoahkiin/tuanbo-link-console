import { parseLinkProject, type LinkProject, type Ma2Catalog, type Ma2ReadState } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { ma2ShowStartTicks, matchMa2Programs, sameMtcStart, type Ma2StartMatch } from './ma2-program-matching';
import { importMa2TimecodeCommand } from './ma2-import';
import { formatMtcOffset } from './mtc-timecode';
import { programTimeOrigin } from './ma2-time-origin';

const noMatch: Ma2StartMatch = { pairs: {}, unresolved: [], duplicateStarts: {}, notes: [] };
const matches = new WeakMap<LinkProject, Ma2StartMatch>();

/**
 * Which console Timecode show runs with which song: worked out from the last console read the project
 * keeps and the songs' MTC starts, every time it is asked for a new project version (2026-10-26, rule 3).
 * Nothing is confirmed by hand and nothing goes stale: a new console Show name, a reopened project or an
 * earlier version's stored pairing changes nothing, only the starts and the show numbers count.
 */
export function ma2SongPairs(project: LinkProject): Ma2StartMatch {
  const catalog = project.ma2ReadState?.catalog;
  if (!catalog) return noMatch;
  let match = matches.get(project);
  if (!match) { match = matchMa2Programs(project, catalog); matches.set(project, match); }
  return match;
}

/**
 * Why the local edits of a song's console Timecode show stay in the software instead of being written
 * (lighting workflow rule 6): the song's MTC start is not the start its Cues were placed from, or the
 * console show (as last read) starts elsewhere. Writing then would put the Cues at the wrong time on the
 * console. Null when they can be written; the write itself still checks the console first. The song plays
 * and sends its timecode either way.
 */
export function ma2BindingHold(project: LinkProject, itemId: string, target: number): string | null {
  const item = project.rundown.find(value => value.id === itemId);
  const binding = item?.lighting?.ma2Bindings?.find(value => value.timecode === target);
  if (!item || !binding) return null;
  let start: number;
  try { start = programTimeOrigin(item); }
  catch (error) { return `「${item.title}」的 MTC 起始码读不出来：${error instanceof Error ? error.message : String(error)}`; }
  const frameRate = project.timebase.frameRate;
  const placed = binding.timeOriginMs ?? 0;
  if (!sameMtcStart(start, placed * 30 / 1000)) return `「${item.title}」里 Timecode ${target} 的 Cue 是按起点 ${formatMtcOffset(placed, frameRate)} 放的，歌曲现在从 ${formatMtcOffset(start, frameRate)} 开始`;
  const entry = project.ma2ReadState?.catalog.entries.find(value => value.target === target);
  const ticks = entry && !entry.error ? ma2ShowStartTicks(entry) : null;
  if (ticks !== null && !sameMtcStart(start, ticks)) return `控台 Timecode ${target} 从 ${formatMtcOffset(ticks * 1000 / 30, frameRate)} 开始，和「${item.title}」的 MTC 起始码 ${formatMtcOffset(start, frameRate)} 对不上`;
  return null;
}

/** The pairs as the project file keeps them for earlier versions: every pair stands on the MTC start, so each is confirmed. */
function storedPairs(match: Ma2StartMatch, catalog: Ma2Catalog): Pick<Ma2ReadState, 'pairs' | 'pairings'> {
  const pairs: Record<string, string> = {}, pairings: NonNullable<Ma2ReadState['pairings']> = {};
  for (const [target, itemId] of Object.entries(match.pairs)) {
    const entry = catalog.entries.find(value => value.target === Number(target));
    pairs[target] = itemId;
    pairings[target] = { itemId, status: 'confirmed', evidence: JSON.stringify({ start: entry ? ma2ShowStartTicks(entry) : null }) };
  }
  return { pairs, pairings };
}

/** The project with its stored pairs brought up to date; the same object when they already are. */
function withStoredPairs(project: LinkProject): LinkProject {
  const state = project.ma2ReadState;
  if (!state) return project;
  const match = matchMa2Programs(project, state.catalog);
  const stored = storedPairs(match, state.catalog);
  if (JSON.stringify(stored.pairs) === JSON.stringify(state.pairs) && JSON.stringify(stored.pairings) === JSON.stringify(state.pairings ?? {})) {
    matches.set(project, match);
    return project;
  }
  return parseLinkProject({ ...project, ma2ReadState: { ...state, ...stored } });
}

/** A new console read: the pairs come from the MTC starts; read failures are kept only for the same Show and session. */
export function reconcileMa2ReadState(project: LinkProject, source: string, catalog: Ma2Catalog): Ma2ReadState {
  const previous = project.ma2ReadState;
  const match = matchMa2Programs(project, catalog);
  const sameSource = previous?.source === source && previous.catalog.directory.show === catalog.directory.show && previous.catalog.directory.generation === catalog.directory.generation;
  const read = catalog.entries.filter(entry => !entry.error).length, failed = catalog.entries.length - read;
  return { formatVersion: 2, source, catalog, ...storedPairs(match, catalog), ...(previous?.detachedBindings ? { detachedBindings: previous.detachedBindings } : {}),
    failures: sameSource ? previous.failures : [], selectedTarget: previous?.selectedTarget ?? null,
    query: previous?.query ?? '', filter: previous?.filter ?? 'all',
    message: `${read} 条已读取 · ${Object.keys(match.pairs).length} 条按起始码对上歌曲${failed ? ` · ${failed} 条读取出错` : ''}${catalog.incomplete ? ' · 还没读完' : ''}` };
}

/** Every project edit keeps the stored pairs in step with the starts, inside the same undoable step. */
export function withMa2Pairings(command: LinkCommand): LinkCommand {
  return { ...command, execute(project) { return withStoredPairs(command.execute(project)); } };
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
    return withStoredPairs(parseLinkProject({ ...next, updatedAt: new Date().toISOString() }));
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
    if (state.catalog.sourceUnverified) throw new Error('读取来源有变化，请重新确认后刷新');
    const ids = new Set(binding.baselineTracks.map(track => track.id));
    const tracks = lighting.tracks.filter(track => ids.has(track.id));
    if (!archiveLocalEdits && (binding.pendingTracks?.length || JSON.stringify(tracks) !== JSON.stringify(binding.baselineTracks))) throw new Error('本地编排已有修改：请选择保留本地，或归档本地后采用控台版本');
    const archived = detachMa2BindingCommand(itemId, target).execute(project);
    return withStoredPairs(importMa2TimecodeCommand(itemId, entry.preview).execute(archived));
  }, undo: before => parseLinkProject(before) };
}
