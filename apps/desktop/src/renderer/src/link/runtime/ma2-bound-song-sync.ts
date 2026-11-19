import { applyMa2ReadbackCommand, ma2BindingHold, ma2LatestChoiceText, ma2LatestSide, ma2PendingChanges, boundEmptyCuePoints, routeBoundEmptyCues, ma2TrackRoutingIssue, ma2PoolSequencesToRoute, routeMa2Tracks, setLightingCommand, sameMa2Content, type LinkCommand, type Ma2SyncPreview } from '@tb/core/link';
import { ma2ApplyResultSchema, ma2TimecodePreviewSchema, type LinkProject, type Ma2SongPoint, type Ma2SongBinding, type Ma2PoolRoute, type Ma2ExecutorReadRequest, type Ma2ExecutorPreview, type Ma2ApplyRequest, type Ma2ConsoleChanges, type Ma2ApplyResult, type Ma2CatalogRequest, type Ma2CompareRequest, type Ma2ReadRequest, type Ma2TimecodePreview } from '@tb/schema';

/** What one pass over a way-1 song (its `ma2Bindings`, the console's own Timecode shows) needs. */
export type BoundSongPass = {
  itemId: string;
  connection: Ma2CatalogRequest;
  /** The operator's choice: console edits come into the song, or the song is written over them. */
  consoleChanges: Ma2ConsoleChanges;
  /** The project of the song's document, or null once another document is open. */
  project: () => LinkProject | null;
  /** False once the song's sync was paused, the document changed or playback started. */
  current: () => boolean;
  executor: (request: Ma2ExecutorReadRequest) => Promise<Ma2ExecutorPreview>;
  assign: (sequence: number) => Promise<Ma2PoolRoute>;
  emptySequence: (points: Ma2SongPoint[], timecode: number, previous?: Ma2SongBinding) => Promise<Ma2SongBinding>;
  route: (command: LinkCommand) => void;
  read: (request: Ma2ReadRequest) => Promise<Ma2TimecodePreview>;
  compare: (request: Ma2CompareRequest) => Promise<Ma2SyncPreview>;
  apply: (request: Ma2ApplyRequest) => Promise<Ma2ApplyResult>;
  /** Runs before the first console write of the pass. */
  archive: () => Promise<void>;
  /** Puts the console's confirmed read-back into the song. */
  confirm: (command: LinkCommand) => void;
  /** A write is about to be sent; `message` says which show. */
  writing: (message: string) => void;
  /** When the operator last changed this song's lighting in the software; undefined when unknown (2026-11-11). */
  localEditedAt: () => number | undefined;
  /**
   * The console's revision of one show as this pass read it: null when it still equals the confirmed
   * baseline, otherwise its XML. Answers when a pass first saw that revision (2026-11-11).
   */
  consoleSeen: (timecode: number, revision: string | null) => number;
};

export type BoundSongOutcome =
  /** Every checked show matches the console. `held` explains which bindings could not be checked because their start moved. */
  | { kind: 'confirmed'; wrote: boolean; timecodes: number[]; held: string | null; chosen: string[] }
  /** An edit, playback or a pause ended the pass before anything uncertain happened; nothing failed. */
  | { kind: 'interrupted'; message: string };

/**
 * Reads each of the song's Timecode shows, compares console, software and the last confirmed
 * baseline, writes only what differs, and takes the console's read-back as the new baseline
 * (lighting workflow rules 5 and 8). The same item changed on both sides: the later change wins
 * (2026-11-11, `ma2LatestSide`; it replaced 2026-10-26's "the software's version") and the losing side
 * stays in the pre-sync archive and in the console backup the write makes. With the timeline chosen
 * over the console (2026-11-04) every console edit is written back instead of taken in. A failure
 * throws; the caller's policy decides whether it is tried again.
 */
export async function syncBoundSong(pass: BoundSongPass): Promise<BoundSongOutcome> {
  const project = pass.project();
  const item = project?.rundown.find(entry => entry.id === pass.itemId);
  if (!project || !item?.lighting?.ma2Bindings?.length) throw new Error('这首歌已不存在，或已没有控台时间码');
  const writable = item.lighting.ma2Bindings.filter(binding => ma2BindingHold(project, item.id, binding.timecode) === null);
  const duplicate = sharedTimecode(project, item.id, writable.map(binding => binding.timecode));
  if (duplicate) throw new Error(duplicate);
  const lighting = () => pass.project()?.rundown.find(entry => entry.id === pass.itemId)?.lighting;
  const same = (left: Ma2SyncPreview['base'], right: Ma2SyncPreview['base']): boolean => sameMa2Content(left, right);
  const interrupted = (message: string): BoundSongOutcome => ({ kind: 'interrupted', message });
  const stopped = '播放或同步状态有变化，停止播放并编辑完后会重新同步';
  let archived = false;
  if (writable.length) {
    const original = item.lighting;
    let prepared = original;
    const empty = boundEmptyCuePoints(original);
    if (empty.length) {
      await pass.archive(); archived = true;
      if (!pass.current() || lighting() !== original) return interrupted(stopped);
      const binding = writable[0]!;
      const result = await pass.emptySequence(empty, binding.timecode, binding.emptyCueSequence);
      if (!pass.current() || lighting() !== original) return interrupted(stopped);
      prepared = routeBoundEmptyCues(original, result);
    }
    let routed = routeMa2Tracks(prepared);
    const sequences = ma2PoolSequencesToRoute(routed);
    const assignments: Ma2PoolRoute[] = [];
    if (sequences.length) {
      if (!archived) { await pass.archive(); archived = true; }
      for (const sequence of sequences) {
        if (!pass.current() || lighting() !== original) return interrupted(stopped);
        assignments.push(await pass.assign(sequence));
      }
      if (!pass.current() || lighting() !== original) return interrupted(stopped);
      routed = routeMa2Tracks(routed, assignments);
    }
    for (const binding of routed.ma2Bindings ?? []) {
      if (!writable.some(value => value.id === binding.id)) continue;
      for (const pending of binding.pendingTracks ?? []) {
        if (pending.executorName !== `执行器 ${pending.executor}`) continue;
        if (!pass.current() || lighting() !== original) return interrupted(stopped);
        const confirmed = await pass.executor({ ...pass.connection, target: binding.timecode, executor: pending.executor });
        if (!pass.current() || lighting() !== original) return interrupted(stopped);
        const track = routed.tracks.find(value => value.id === pending.trackId);
        if (confirmed.executor !== pending.executor || track?.clips.some(clip => clip.events.some(event => event.kind === 'ma2' && event.action === 'goto' && event.sequence !== confirmed.cueCatalog[0]?.sequence))) throw new Error(`执行器 ${pending.executor} 使用的序列和轨道上的 Cue 不一致，请核对控台素材`);
        if (routed === original) routed = structuredClone(original);
        const lane = routed.ma2Bindings?.find(value => value.id === binding.id)?.pendingTracks?.find(value => value.trackId === pending.trackId);
        if (lane) lane.executorName = confirmed.executorName;
      }
    }
    if (routed !== original) {
      // Routing is console bookkeeping. Undo must still reach the operator's placement in one step.
      pass.route({ ...setLightingCommand(item.id, routed, '关联新增灯光轨道'), historyRebaseKey: `ma2-pool-route:${item.id}`, rebaseHistory: before => before });
    }
    const routingIssue = ma2TrackRoutingIssue(routed);
    if (routingIssue) throw new Error(routingIssue);
    const invalid = ma2PendingChanges(pass.project()).find(change => change.itemId === item.id && change.error && writable.some(binding => binding.timecode === change.target));
    if (invalid) throw new Error(`Timecode ${invalid.target}：${invalid.error}`);
  }
  let wrote = false;
  const chosen: string[] = [];
  for (const bindingId of writable.map(binding => binding.id)) {
    if (!pass.current()) return interrupted(stopped);
    const source = lighting();
    const binding = source?.ma2Bindings?.find(entry => entry.id === bindingId);
    // Unbound or switched to another show meanwhile: an edit, synced on its own pass.
    if (!source || !binding) return interrupted('这首歌的控台时间线刚换过，稍后再同步');
    const changes = ma2PendingChanges(pass.project()).find(change => change.itemId === item.id && change.bindingId === binding.id);
    const knownSequences = new Set(binding.mappings.map(mapping => mapping.sequence));
    const syncSequences = changes?.changes.flatMap(change => {
      const sequence = Number(change.after?.properties.sequence);
      return change.after?.kind === 'event' && sequence > 0 && !knownSequences.has(sequence) ? [sequence] : [];
    });
    const readback = ma2TimecodePreviewSchema.parse(await pass.read({ ...pass.connection, target: binding.timecode, timeOriginMs: binding.timeOriginMs,
      ...(syncSequences && { syncSequences: [...new Set(syncSequences)].sort((a, b) => a - b) }) }));
    if (!pass.current()) return interrupted(stopped);
    if (lighting() !== source) return interrupted('还在编辑，稍后再同步');
    const comparison = await pass.compare({ document: source, bindingId: binding.id, readback, consoleChanges: pass.consoleChanges });
    if (!pass.current()) return interrupted(stopped);
    const consoleSeenAt = pass.consoleSeen(binding.timecode, same(comparison.base, comparison.remote) ? null : readback.sourceXml);
    if (same(comparison.base, comparison.local) && same(comparison.base, comparison.remote)) continue;
    if (lighting() !== source) return interrupted('还在编辑，稍后再同步');
    if (!archived) { await pass.archive(); archived = true; }
    if (!pass.current()) return interrupted(stopped);
    if (lighting() !== source) return interrupted('存档期间本地又有修改，稍后再同步');
    // 以联动台为准 (2026-11-04) keeps the timeline; reading console edits back, the latest wins (2026-11-11).
    const side = pass.consoleChanges === 'software' ? 'local' : ma2LatestSide({ localEditedAt: pass.localEditedAt(), consoleSeenAt });
    const conflicts = comparison.conflicts.map(conflict => [conflict.id, side] as [string, typeof side]);
    const choice = !conflicts.length ? null : pass.consoleChanges === 'software' ? `Timecode ${binding.timecode} 有 ${conflicts.length} 处两边都改过，以联动台为准写入` : ma2LatestChoiceText(`Timecode ${binding.timecode}`, conflicts.length, side);
    if (choice) chosen.push(choice);
    pass.writing(choice ? `${choice}，正在写入并读取控台确认` : `正在同步 Timecode ${binding.timecode}…`);
    const result = ma2ApplyResultSchema.parse(await pass.apply({ ...pass.connection, document: source, bindingId: binding.id, readback, conflicts, timeAlignment: 'nearest-frame', consoleChanges: pass.consoleChanges }));
    if (result.status === 'incomplete') throw new Error(`${result.message}${result.mayHaveWritten ? '；控台可能已经写入' : ''}${result.backupFile ? `；备份：${result.backupFile}` : ''}`);
    wrote = true;
    // The console confirmed the write: its read-back belongs to this song even when the sync was
    // paused meanwhile, but never to another document.
    if (!pass.project()) throw new Error('控台已写入，但工程已切换；回到原来的工程后点“刷新同步”核对');
    pass.confirm(applyMa2ReadbackCommand(item.id, binding.id, source, result.confirmed, same(comparison.base, comparison.remote)));
  }
  const latest = pass.project();
  if (!latest) return interrupted('工程已经切换');
  const held = heldMessage(latest, item.id);
  if (!writable.length && !held) return interrupted('这首歌的控台时间线刚换过，稍后再同步');
  return { kind: 'confirmed', wrote, timecodes: writable.map(binding => binding.timecode), held, chosen };
}

/** A Timecode show bound to two songs, or twice to one, is never written automatically. */
function sharedTimecode(project: LinkProject, itemId: string, timecodes: readonly number[]): string | null {
  if (new Set(timecodes).size !== timecodes.length) return '这首歌关联了同一条控台时间线两次，不能自动同步。请在「灯光工作台 → 控台时间线」里对这条时间线点“解除关联并归档编排”，再用“给哪首歌用”选回这首歌';
  for (const other of project.rundown) {
    if (other.id === itemId) continue;
    const shared = other.lighting?.ma2Bindings?.find(binding => timecodes.includes(binding.timecode) && ma2BindingHold(project, other.id, binding.timecode) === null);
    if (shared) return `Timecode ${shared.timecode} 同时给了“${other.title}”和这首歌用，不能自动同步。请在「灯光工作台 → 控台时间线」里的 Timecode ${shared.timecode} 用“给哪首歌用”选定一首，或在不用它的那首歌上点“解除关联并归档编排”`;
  }
  return null;
}

/**
 * Only a show that still starts where its song starts is written (lighting workflow rule 6); the edits
 * of a song whose start moved stay in the software, and that song plays as usual.
 */
function heldMessage(project: LinkProject, itemId: string): string | null {
  const bindings = project.rundown.find(item => item.id === itemId)?.lighting?.ma2Bindings ?? [];
  const reasons = new Set(bindings.flatMap(binding => ma2BindingHold(project, itemId, binding.timecode) ?? []));
  return reasons.size ? `${[...reasons].join('；')}。编辑的改动先留在联动台，起始码对上后会自动同步` : null;
}
