import { parseLinkProject, ma2TimecodePreviewSchema, type LinkProject, type Ma2Catalog, type Ma2ReadState, type Ma2TimecodePreview } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { ma2ShowStartTicks, matchMa2Programs, sameMtcStart, type Ma2StartMatch, type Ma2TimelineSwitch } from './ma2-program-matching';
import { importMa2TimecodeCommand } from './ma2-import';
import { formatMtcOffset } from './mtc-timecode';
import { MA2_FRAME_MS, programTimeOrigin } from './ma2-time-origin';

const noMatch: Ma2StartMatch = { pairs: {}, unresolved: [], duplicateStarts: {}, notes: [], switches: [] };
const matches = new WeakMap<LinkProject, Ma2StartMatch>();

/** Why the switch to a show failed, as the read state keeps it until the console is read again. */
function failedSwitches(state: Ma2ReadState): Map<number, string> {
  return new Map(state.failures.map(failure => [failure.target, failure.message]));
}

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
  if (!match) { match = matchMa2Programs(project, catalog, failedSwitches(project.ma2ReadState!)); matches.set(project, match); }
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

/**
 * The project with its songs on the console shows their MTC starts name and its stored pairs brought up
 * to date; the same object when they already are. A song whose start moved onto another show changes
 * over to it here, inside the edit that moved the start, so undo takes both back (2026-11-04).
 */
function withStoredPairs(project: LinkProject): LinkProject {
  if (!project.ma2ReadState) return project;
  let current = project;
  let match = matchMa2Programs(current, current.ma2ReadState!.catalog, failedSwitches(current.ma2ReadState!));
  if (match.switches.length) {
    current = switchMa2Timelines(current, match.switches);
    match = matchMa2Programs(current, current.ma2ReadState!.catalog, failedSwitches(current.ma2ReadState!));
  }
  const state = current.ma2ReadState!;
  const stored = storedPairs(match, state.catalog);
  if (JSON.stringify(stored.pairs) === JSON.stringify(state.pairs) && JSON.stringify(stored.pairings) === JSON.stringify(state.pairings ?? {})) {
    matches.set(current, match);
    return current;
  }
  return parseLinkProject({ ...current, ma2ReadState: { ...state, ...stored } });
}

/**
 * Moves each song onto the console show its MTC start now names. The Cues of the shows it leaves are
 * archived with their local edits, as 解除关联并归档编排 does. The new show's Cues are the archived ones
 * when the song held that show before from the same start (switching back), otherwise the last read.
 * A switch that fails leaves the song as it was and keeps why with that show, where the console
 * timeline view shows it; the edit that moved the start still goes through.
 */
function switchMa2Timelines(project: LinkProject, switches: readonly Ma2TimelineSwitch[]): LinkProject {
  let current = project;
  for (const change of switches) {
    try {
      const next = structuredClone(current);
      for (const target of change.from) archiveBinding(next, change.itemId, target);
      const restored = restoreArchivedBinding(next, change.itemId, change.to);
      const entry = next.ma2ReadState?.catalog.entries.find(value => value.target === change.to);
      if (!restored && !entry?.preview) throw new Error(`控台 Timecode ${change.to} 还没读取完整`);
      const switched = restored ? next : importMa2TimecodeCommand(change.itemId, entry!.preview!).execute(next);
      const state = switched.ma2ReadState!;
      current = parseLinkProject({ ...switched, updatedAt: new Date().toISOString(), ma2ReadState: { ...state, failures: state.failures.filter(failure => failure.target !== change.to) } });
    } catch (error) {
      const state = current.ma2ReadState!;
      const message = error instanceof Error ? error.message : String(error);
      current = parseLinkProject({ ...current, ma2ReadState: { ...state, failures: [...state.failures.filter(failure => failure.target !== change.to), { target: change.to, message }] } });
    }
  }
  return current;
}

/** Moves a song's Cues of one console show out of its timeline into the read state's archive. `next` is a working copy. */
function archiveBinding(next: LinkProject, itemId: string, target: number): void {
  const state = next.ma2ReadState;
  const lighting = next.rundown.find(item => item.id === itemId)?.lighting;
  const binding = lighting?.ma2Bindings?.find(value => value.timecode === target);
  if (!state || !lighting || !binding) throw new Error('关联已不存在');
  const ids = new Set([...binding.baselineTracks.map(track => track.id), ...(binding.pendingTracks ?? []).map(track => track.trackId)]);
  state.detachedBindings = [...state.detachedBindings ?? [], { itemId, detachedAt: new Date().toISOString(), binding, tracks: lighting.tracks.filter(track => ids.has(track.id)) }];
  state.formatVersion = 2;
  lighting.tracks = lighting.tracks.filter(track => !ids.has(track.id));
  lighting.ma2Bindings = lighting.ma2Bindings?.filter(value => value.id !== binding.id);
}

/**
 * Puts the song's latest archived Cues of a show back on its timeline, when they were placed from the
 * song's present MTC start. False when there are none. `next` is a working copy.
 */
function restoreArchivedBinding(next: LinkProject, itemId: string, target: number): boolean {
  const state = next.ma2ReadState;
  const item = next.rundown.find(value => value.id === itemId);
  const archived = state?.detachedBindings?.slice().reverse().find(value => value.itemId === itemId && value.binding.timecode === target);
  if (!state || !item?.lighting || !archived || Math.abs((archived.binding.timeOriginMs ?? 0) - programTimeOrigin(item)) >= MA2_FRAME_MS) return false;
  item.lighting.tracks.push(...archived.tracks);
  item.lighting.ma2Bindings = [...item.lighting.ma2Bindings ?? [], archived.binding];
  state.detachedBindings = state.detachedBindings?.filter(value => value !== archived);
  return true;
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

/**
 * The operator picks the song a console Timecode show runs with (2026-11-04). Pairing stays by the MTC
 * start alone (lighting workflow rule 3): the song's start becomes the show's start. A song holding
 * Cues of another show then changes over to this one in the pairing step, as any moved start does; a
 * song holding none takes this show's Cues in the same step. A switch to this show that failed before
 * is tried again.
 */
export function pairSongWithMa2ShowCommand(itemId: string, target: number): LinkCommand {
  return { id: crypto.randomUUID(), label: '让歌曲用这条控台时间线', execute(project) {
    const state = project.ma2ReadState;
    const entry = state?.catalog.entries.find(value => value.target === target);
    const item = project.rundown.find(value => value.id === itemId);
    if (!state || !entry) throw new Error(`控台读取结果里没有 Timecode ${target}`);
    if (!item) throw new Error('这首歌已不存在');
    if (!item.referenceAudio) throw new Error(`「${item.title}」没有音频，配不上控台时间线`);
    if (item.lighting?.consoleSong) throw new Error(`「${item.title}」用的是联动台给它建的控台序列，不换用控台上的其他时间线`);
    const ticks = entry.error ? null : ma2ShowStartTicks(entry);
    if (ticks === null) throw new Error(`控台 Timecode ${target} 的起点读不懂，没法对上歌曲`);
    const frameRate = project.timebase.frameRate;
    const owner = project.rundown.find(value => value.id !== itemId && value.lighting?.ma2Bindings?.some(binding => binding.timecode === target));
    if (owner) throw new Error(`Timecode ${target} 的 Cue 已经放在「${owner.title}」里，请先在那首歌上解除关联`);
    const startMs = Math.ceil(ticks * 1000 / 30);
    const sharing = project.rundown.find(value => {
      if (value.id === itemId || !value.playback && !value.p1Media) return false;
      try { return sameMtcStart(programTimeOrigin(value), ticks); }
      catch { return false; }
    });
    if (sharing) throw new Error(`「${sharing.title}」的起始码也是 ${formatMtcOffset(startMs, frameRate)}，两首歌同一个起点分不清；请先改开它的起始码`);
    const next = structuredClone(project);
    const song = next.rundown.find(value => value.id === itemId)!;
    song.playback = { ...song.playback ?? { volume: song.p1Media?.volume ?? 100, startMs: 0, endMs: 0, shortcut: song.p1Media?.shortcut ?? '' }, mtcOffsetMs: startMs };
    next.ma2ReadState = { ...state, failures: state.failures.filter(failure => failure.target !== target) };
    if (!song.lighting?.ma2Bindings?.length && !restoreArchivedBinding(next, itemId, target)) {
      if (!entry.preview || entry.conversionError) throw new Error(entry.conversionError ?? `Timecode ${target} 还没读取完整，请先“只补读未完成项”`);
      return importMa2TimecodeCommand(itemId, entry.preview).execute(parseLinkProject({ ...next, updatedAt: new Date().toISOString() }));
    }
    return parseLinkProject({ ...next, updatedAt: new Date().toISOString() });
  }, undo: before => parseLinkProject(before) };
}

/** Preserve the complete native baseline and local edits outside the active playback document. */
export function detachMa2BindingCommand(itemId: string, target: number): LinkCommand {
  return { id: crypto.randomUUID(), label: '解除控台关联并归档本地编排', execute(project) {
    const next = structuredClone(project);
    archiveBinding(next, itemId, target);
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
    state.detachedBindings = state.detachedBindings?.filter(value => value !== archived);
    next.ma2ReadState = reconcileMa2ReadState(next, state.source, state.catalog);
    return parseLinkProject({ ...next, updatedAt: new Date().toISOString() });
  }, undo: before => parseLinkProject(before) };
}

/**
 * Takes the console's version of one of a song's Timecode shows as the song's Cues. `fresh` is that show
 * as just read from the console (2026-11-11: 用控台上的, and the console timeline page's refresh while
 * connected); without it, the project's last console read. The song's own Cues of that show, with its
 * unsynced edits, go to the read state's archive first; a song bound by hand, without a console read
 * in the project, has them in the project archive taken before.
 */
export function refreshMa2BindingCommand(itemId: string, target: number, archiveLocalEdits = false, fresh?: Ma2TimecodePreview): LinkCommand {
  const read = fresh ? ma2TimecodePreviewSchema.parse(fresh) : undefined;
  if (read && read.target !== target) throw new Error(`读到的是 Timecode ${read.target}，不是 Timecode ${target}`);
  return { id: crypto.randomUUID(), label: read ? '用控台上的灯光' : '从工程缓存刷新已绑定灯光', execute(project) {
    const state = project.ma2ReadState;
    const entry = state?.catalog.entries.find(value => value.target === target);
    const lighting = project.rundown.find(item => item.id === itemId)?.lighting;
    const binding = lighting?.ma2Bindings?.find(value => value.timecode === target);
    if (!binding || !lighting) throw new Error(`这首歌已经不用 Timecode ${target}`);
    const preview = read ?? (state && entry?.preview && !entry.error ? entry.preview : undefined);
    if (!preview) throw new Error('此时间线没有完整的已读内容');
    if (!read && state?.catalog.sourceUnverified) throw new Error('读取来源有变化，请重新确认后刷新');
    const ids = new Set(binding.baselineTracks.map(track => track.id));
    const tracks = lighting.tracks.filter(track => ids.has(track.id));
    if (!archiveLocalEdits && (binding.pendingTracks?.length || JSON.stringify(tracks) !== JSON.stringify(binding.baselineTracks))) throw new Error('本地编排已有修改：请选择保留本地，或归档本地后采用控台版本');
    const archived = state ? detachMa2BindingCommand(itemId, target).execute(project) : withoutBinding(project, itemId, target);
    return withStoredPairs(importMa2TimecodeCommand(itemId, preview).execute(archived));
  }, undo: before => parseLinkProject(before) };
}

/** The song without one show's Cues, for a song whose show was bound by hand: there is no read state to archive them in. */
function withoutBinding(project: LinkProject, itemId: string, target: number): LinkProject {
  const next = structuredClone(project);
  const lighting = next.rundown.find(item => item.id === itemId)?.lighting;
  const binding = lighting?.ma2Bindings?.find(value => value.timecode === target);
  if (!lighting || !binding) throw new Error('关联已不存在');
  const ids = new Set([...binding.baselineTracks.map(track => track.id), ...(binding.pendingTracks ?? []).map(track => track.trackId)]);
  lighting.tracks = lighting.tracks.filter(track => !ids.has(track.id));
  lighting.ma2Bindings = lighting.ma2Bindings?.filter(value => value.id !== binding.id);
  return next;
}
