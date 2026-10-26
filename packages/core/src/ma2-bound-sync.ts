import { lightingDocumentSchema, ma2SyncSnapshotSchema, ma2TimecodePreviewSchema, type LightingDocument, type Ma2SyncObject, type Ma2TimecodePreview } from '@tb/schema';
import { resolveMa2Readback, resolveMa2ReadbackTracks } from './ma2-readback';
import { ma2EventSnapshotProperties, snapshotMa2LightingBinding } from './ma2-lighting-snapshot';
import { previewMa2Sync, type Ma2SyncPreview } from './ma2-sync';

export function previewMa2BoundSync(documentInput: LightingDocument, bindingId: string, readbackInput: Ma2TimecodePreview, choices: ReadonlyMap<string, string | null>, metadata: { baselineVersion: string; remoteVersion: string; baselineRevision: string; localRevision: string; remoteRevision: string }): Ma2SyncPreview {
  const document = lightingDocumentSchema.parse(documentInput);
  const readback = ma2TimecodePreviewSchema.parse(readbackInput);
  const binding = document.ma2Bindings?.find((entry) => entry.id === bindingId);
  if (!binding) throw new Error('节目没有这个 MA2 对象绑定');
  if (binding.nativeEvents?.length || binding.playback === 'native-timecode' || readback.unconverted.length) throw new Error('保持控台原样的时间线不能写回，控台仍可按原来的时间码播放');
  const matched = resolveMa2Readback(binding, readback, choices);
  const identities = new Map(matched.matches.map((entry) => [entry.remoteEventId, entry.baselineEventId]));
  const trackIdentities = resolveMa2ReadbackTracks(binding, readback, matched);
  const snapshots = snapshotMa2LightingBinding(document, bindingId, { consoleVersion: metadata.baselineVersion, baselineRevision: metadata.baselineRevision, localRevision: metadata.localRevision });
  const objects: Ma2SyncObject[] = [{ id: bindingId, kind: 'timecode', parentId: null, order: 0, properties: { number: String(binding.timecode), name: readback.name } }];
  for (const [order, track] of readback.document.tracks.entries()) {
    const trackId = trackIdentities.get(track.id);
    if (!trackId) throw new Error('控台轨道映射缺失');
    objects.push({ id: trackId, kind: 'track', parentId: bindingId, order, properties: { name: track.name, muted: String(track.muted) } });
    for (const clip of track.clips) for (const event of clip.events) {
      if ((event.kind !== 'ma2' && event.kind !== 'ma2-fader') || clip.timeLock !== 'time') throw new Error('控台事件还没转换成 MA2 绝对时间');
      objects.push({ id: identities.get(event.id) ?? `remote-event:${event.id}`, kind: 'event', parentId: trackId, order: 0,
        properties: ma2EventSnapshotProperties(event, clip.start + event.at, clip.muted, event.label) });
    }
  }
  const remote = ma2SyncSnapshotSchema.parse({ bindingId, consoleVersion: metadata.remoteVersion, revision: metadata.remoteRevision, objects });
  return previewMa2Sync(snapshots.base, snapshots.local, remote);
}
