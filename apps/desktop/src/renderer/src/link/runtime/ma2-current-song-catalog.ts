import { reconcileMa2ReadState, saveMa2ReadStateCommand } from '@tb/core/link';
import { ma2CatalogSchema, type Ma2Catalog, type Ma2NetworkTarget } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';

/** A selected song can return after an empty Show was read. Repair its saved pairing
 * from the current console without exporting the rest of the Show. */
export async function refreshSongCatalog(network: Ma2NetworkTarget, source: string, checked: Ma2Catalog, current: () => boolean): Promise<void> {
  const document = useDocumentStore.getState();
  const previous = document.project?.ma2ReadState;
  if (!previous || !checked.songOffsets?.length) return;
  const { show, generation, version } = checked.directory;
  const saved = previous.catalog;
  const sameShow = previous.source === source && saved.directory.show === show && saved.directory.version === version && !saved.sourceUnverified;
  const sameSession = sameShow && saved.directory.generation === generation;
  const targets = checked.songOffsets.filter(({ target, offset }) => {
    const entry = saved.entries.find(value => value.target === target);
    return !sameSession || !entry || Boolean(entry.error) || Number(entry.offset ?? 0) !== Number(offset);
  }).map(entry => entry.target);
  if (!targets.length) {
    if (current() && checked.afterRollSeconds !== undefined && checked.afterRollSeconds !== saved.afterRollSeconds) {
      document.executeForDocument(document.documentId, saveMa2ReadStateCommand({ ...previous, catalog: { ...saved, afterRollSeconds: checked.afterRollSeconds } }));
    }
    return;
  }
  const read = ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ dataDirectory: '', network, targets, expectedSource: { show, generation, version } }));
  if (!current()) return;
  if (read.incomplete || read.sourceUnverified || read.directory.show !== show || read.directory.generation !== generation || read.directory.version !== version
    || !targets.every(target => read.entries.some(entry => entry.target === target && !entry.error && Number(entry.offset ?? 0) === Number(checked.songOffsets?.find(value => value.target === target)?.offset)))) {
    throw new Error('当前节目的控台时间线还没核对清楚，请重新同步');
  }
  const latest = useDocumentStore.getState();
  if (!latest.project || latest.project.ma2ReadState !== previous) throw new Error('同步期间控台读取结果已更新，请重新核对当前节目');
  // Restarting the bridge does not clear the other songs. Keep their original read times
  // if the fresh directory still identifies the same objects in the same Show.
  const retained = sameShow ? saved.entries : [];
  const rows = new Map(retained.map(entry => [entry.target, entry.readAt ? entry : { ...entry, readAt: saved.readAt }]));
  for (const entry of read.entries) rows.set(entry.target, entry);
  const entries = read.directory.entries.flatMap(entry => rows.get(entry.target) ?? []);
  const incomplete = entries.length < read.directory.entries.length ? '已核对当前节目，其余时间线可在控台时间线页面读取' : undefined;
  const catalog: Ma2Catalog = { directory: read.directory, afterRollSeconds: checked.afterRollSeconds, entries, readAt: read.readAt, sourceUnverified: false, incomplete };
  latest.executeForDocument(document.documentId, saveMa2ReadStateCommand(reconcileMa2ReadState(latest.project, source, catalog)));
}
