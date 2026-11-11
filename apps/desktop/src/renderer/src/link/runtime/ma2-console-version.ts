import { refreshMa2BindingCommand, type LinkCommand } from '@tb/core/link';
import { ma2TimecodePreviewSchema, type Ma2TimecodePreview } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { currentShowWait } from '../stores/show-state-store';

/**
 * One console Timecode show read right now (2026-11-11), the same read each sync pass makes. Null when
 * the console is not connected over the network; the caller says it uses the last read instead. A moving
 * program is never interrupted by a read: it throws showGate's text, which says to pause or stop first.
 */
export async function readMa2ShowNow(target: number, timeOriginMs: number | undefined): Promise<Ma2TimecodePreview | null> {
  const status = await window.tbLink.getMa2NetworkStatus();
  if (status.state !== 'connected' || !status.settings) return null;
  const wait = currentShowWait('ma2.sync.read');
  if (wait) throw new Error(wait);
  const { host, port, monitorPort, username } = status.settings;
  return ma2TimecodePreviewSchema.parse(await window.tbLink.previewMa2({ dataDirectory: '', network: { host, port, monitorPort, username }, target, timeOriginMs }));
}

/**
 * 用控台上的 for a way-1 song (2026-11-11): every Timecode show the song uses is read from the console
 * now and becomes the song's Cues, in one undoable step; the song's unsynced lighting edits go to the
 * archive. Throws when the console is not connected: the last read is not "the console's version".
 */
export async function readMa2SongFromConsole(itemId: string): Promise<{ command: LinkCommand; timecodes: number[] }> {
  const item = useDocumentStore.getState().project?.rundown.find(value => value.id === itemId);
  const bindings = item?.lighting?.ma2Bindings ?? [];
  if (!item || !bindings.length) throw new Error('这首歌已经不用控台上的时间线');
  const reads: Ma2TimecodePreview[] = [];
  for (const binding of bindings) {
    const read = await readMa2ShowNow(binding.timecode, binding.timeOriginMs);
    if (!read) throw new Error('控台没连上，读不到控台上现在的版本；连上后再点“用控台上的”');
    reads.push(read);
  }
  const steps = reads.map(read => refreshMa2BindingCommand(itemId, read.target, true, read));
  return { timecodes: reads.map(read => read.target), command: { id: crypto.randomUUID(), label: '用控台上的灯光', execute: project => steps.reduce((value, step) => step.execute(value), project), undo: before => before } };
}
