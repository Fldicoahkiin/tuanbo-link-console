import { applyMa2ReadbackCommand, ma2BindingHold, ma2PendingChanges, matchMa2Readback, type LinkCommand, type Ma2PendingChange, type Ma2SyncPreview } from '@tb/core/link';
import { ma2ApplyResultSchema, ma2TimecodePreviewSchema, type LinkProject, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2CatalogRequest, type Ma2CompareRequest, type Ma2ReadRequest, type Ma2TimecodePreview } from '@tb/schema';

/** What one pass over a way-1 song (its `ma2Bindings`, the console's own Timecode shows) needs. */
export type BoundSongPass = {
  itemId: string;
  connection: Ma2CatalogRequest;
  /** The project of the song's document, or null once another document is open. */
  project: () => LinkProject | null;
  /** False once the song's sync was paused, the document changed or playback started. */
  current: () => boolean;
  read: (request: Ma2ReadRequest) => Promise<Ma2TimecodePreview>;
  compare: (request: Ma2CompareRequest) => Promise<Ma2SyncPreview>;
  apply: (request: Ma2ApplyRequest) => Promise<Ma2ApplyResult>;
  /** Runs before the first console write of the pass. */
  archive: () => Promise<void>;
  /** Puts the console's confirmed read-back into the song. */
  confirm: (command: LinkCommand) => void;
  /** A write is about to be sent; `message` says which show. */
  writing: (message: string) => void;
};

export type BoundSongOutcome =
  /** Every show the song may write now matches the console. `held`: edits kept in the software because the song's start moved. */
  | { kind: 'confirmed'; wrote: boolean; timecodes: number[]; held: string | null }
  /** An edit, playback or a pause ended the pass before anything uncertain happened; nothing failed. */
  | { kind: 'interrupted'; message: string };

/**
 * Reads each of the song's Timecode shows, compares console, software and the last confirmed
 * baseline, writes only what differs, and takes the console's read-back as the new baseline
 * (lighting workflow rules 5 and 8). The same item changed on both sides: the software's version is
 * written and the console's stays in the backup the write makes (2026-10-26). A failure throws; the
 * caller's policy decides whether it is tried again.
 */
export async function syncBoundSong(pass: BoundSongPass): Promise<BoundSongOutcome> {
  const project = pass.project();
  const item = project?.rundown.find(entry => entry.id === pass.itemId);
  if (!project || !item?.lighting?.ma2Bindings?.length) throw new Error('这首歌已不存在，或已没有控台时间码');
  const writable = item.lighting.ma2Bindings.filter(binding => ma2BindingHold(project, item.id, binding.timecode) === null);
  const invalid = ma2PendingChanges(project).find(change => change.itemId === item.id && change.error && ma2BindingHold(project, item.id, change.target) === null);
  if (invalid) throw new Error(`Timecode ${invalid.target}：${invalid.error}`);
  const duplicate = sharedTimecode(project, item.id, writable.map(binding => binding.timecode));
  if (duplicate) throw new Error(duplicate);
  const lighting = () => pass.project()?.rundown.find(entry => entry.id === pass.itemId)?.lighting;
  const same = (left: Ma2SyncPreview['base'], right: Ma2SyncPreview['base']): boolean => JSON.stringify(left.objects) === JSON.stringify(right.objects);
  const interrupted = (message: string): BoundSongOutcome => ({ kind: 'interrupted', message });
  const stopped = '播放或同步状态有变化，停止播放并编辑完后会重新同步';
  let archived = false;
  let wrote = false;
  for (const bindingId of writable.map(binding => binding.id)) {
    if (!pass.current()) return interrupted(stopped);
    const source = lighting();
    const binding = source?.ma2Bindings?.find(entry => entry.id === bindingId);
    if (!source || !binding) throw new Error('同步期间这首歌的控台时间码绑定变了');
    const readback = ma2TimecodePreviewSchema.parse(await pass.read({ ...pass.connection, target: binding.timecode, timeOriginMs: binding.timeOriginMs }));
    if (!pass.current()) return interrupted(stopped);
    if (lighting() !== source) return interrupted('还在编辑，稍后再同步');
    if (matchMa2Readback(binding, readback).ambiguous.length) throw new Error(`Timecode ${binding.timecode} 里有对不上的事件，请在手动同步中确认`);
    const comparison = await pass.compare({ document: source, bindingId: binding.id, readback, choices: [] });
    if (!pass.current()) return interrupted(stopped);
    if (same(comparison.base, comparison.local) && same(comparison.base, comparison.remote)) continue;
    if (lighting() !== source) return interrupted('还在编辑，稍后再同步');
    if (!archived) { await pass.archive(); archived = true; }
    if (!pass.current()) return interrupted(stopped);
    if (lighting() !== source) return interrupted('存档期间本地又有修改，稍后再同步');
    const conflicts = comparison.conflicts.map(conflict => [conflict.id, 'local'] as [string, 'local']);
    pass.writing(conflicts.length ? `Timecode ${binding.timecode} 有 ${conflicts.length} 处两边都改过，以联动台为准写入并回读确认` : `正在同步 Timecode ${binding.timecode}…`);
    const result = ma2ApplyResultSchema.parse(await pass.apply({ ...pass.connection, document: source, bindingId: binding.id, readback, choices: [], conflicts, timeAlignment: 'nearest-frame' }));
    if (result.status === 'incomplete') throw new Error(`${result.message}${result.mayHaveWritten ? '；控台可能已经写入' : ''}${result.backupFile ? `；备份：${result.backupFile}` : ''}`);
    wrote = true;
    // The console confirmed the write: its read-back belongs to this song even when the sync was
    // paused meanwhile, but never to another document.
    if (!pass.project()) throw new Error('控台已写入，但工程已切换；回到原来的工程后点“刷新同步”核对');
    pass.confirm(applyMa2ReadbackCommand(item.id, binding.id, source, result.confirmed, same(comparison.base, comparison.remote)));
  }
  const latest = pass.project();
  return { kind: 'confirmed', wrote, timecodes: writable.map(binding => binding.timecode), held: latest ? heldMessage(latest, item.id) : null };
}

/** A Timecode show bound to two songs, or twice to one, is never written automatically. */
function sharedTimecode(project: LinkProject, itemId: string, timecodes: readonly number[]): string | null {
  if (new Set(timecodes).size !== timecodes.length) return '这首歌绑定了同一条控台时间线两次，不能自动同步，请在手动同步里只留一条';
  for (const other of project.rundown) {
    if (other.id === itemId) continue;
    const shared = other.lighting?.ma2Bindings?.find(binding => timecodes.includes(binding.timecode) && ma2BindingHold(project, other.id, binding.timecode) === null);
    if (shared) return `Timecode ${shared.timecode} 同时绑定在“${other.title}”上，不能自动同步，请在手动同步里只留一首`;
  }
  return null;
}

/**
 * Only a show that still starts where its song starts is written (lighting workflow rule 6); the edits
 * of a song whose start moved stay in the software, and that song plays as usual.
 */
function heldMessage(project: LinkProject, itemId: string): string | null {
  const held: Ma2PendingChange[] = ma2PendingChanges(project).filter(change => change.itemId === itemId && ma2BindingHold(project, itemId, change.target) !== null);
  if (!held.length) return null;
  const reasons = [...new Set(held.flatMap(change => ma2BindingHold(project, itemId, change.target) ?? []))];
  return `${reasons.join('；')}。这些改动先留在联动台，没有写到控台；起始码对上后会自动同步`;
}
