import { lightingDocumentSchema, ma2SyncSnapshotSchema, type LightingDocument, type LightingEvent, type LightingTrack, type Ma2SyncObject, type Ma2SyncSnapshot } from '@tb/schema';
import { LightingTempoMap, lightingEventTime } from './lighting-edit';

/** Project the bound programme data into the shared three-way comparison model. */
export function snapshotMa2LightingBinding(document: LightingDocument, bindingId: string, metadata: { consoleVersion: string; baselineRevision: string; localRevision: string }): { base: Ma2SyncSnapshot; local: Ma2SyncSnapshot } {
  const parsed = lightingDocumentSchema.parse(document);
  const binding = parsed.ma2Bindings?.find((entry) => entry.id === bindingId);
  if (!binding) throw new Error('节目没有这个 MA2 对象绑定');
  const trackIds = new Set([...binding.baselineTracks.map((track) => track.id), ...(binding.pendingTracks ?? []).map((track) => track.trackId)]);
  const nativeTrackNames = new Map([...binding.baselineTracks.map((track) => [track.id, track.name] as const), ...(binding.pendingTracks ?? []).map((track) => [track.trackId, track.executorName] as const)]);
  const nativeNames = new Map(binding.baselineTracks.flatMap((track) => track.clips.flatMap((clip) => clip.events.flatMap((event) => event.kind === 'ma2' ? [[event.id, event.label] as const] : []))));
  const map = new LightingTempoMap(parsed.tempos);
  const root: Ma2SyncObject = { id: binding.id, kind: 'timecode', parentId: null, order: 0, properties: { number: String(binding.timecode), name: binding.name } };
  const snapshot = (tracks: LightingTrack[], revision: string, local = false): Ma2SyncSnapshot => {
    const objects: Ma2SyncObject[] = [root];
    for (const [order, track] of tracks.entries()) {
      // Imported track titles describe the referenced executor; local lane labels do not rename it.
      objects.push({ id: track.id, kind: 'track', parentId: root.id, order, properties: { name: local ? nativeTrackNames.get(track.id) ?? track.name : track.name, muted: String(track.muted) } });
      for (const clip of track.clips) for (const event of clip.events) {
        if (event.kind !== 'ma2' && event.kind !== 'ma2-fader') throw new Error(`MA2 绑定轨道“${track.name}”包含尚未映射的 ${event.kind} 事件`);
        objects.push({ id: event.id, kind: 'event', parentId: track.id, order: 0,
          properties: ma2EventSnapshotProperties(event, lightingEventTime(clip, event, map), clip.muted, local ? nativeNames.get(event.id) ?? '' : event.label) });
      }
    }
    return ma2SyncSnapshotSchema.parse({ bindingId, consoleVersion: metadata.consoleVersion, revision, objects });
  };
  // Native MA2 baselines have absolute time, independent of the programme BPM.
  if (binding.baselineTracks.some((track) => track.clips.some((clip) => clip.timeLock !== 'time'))) throw new Error('MA2 同步基线必须保留绝对时间');
  return { base: snapshot(binding.baselineTracks, metadata.baselineRevision), local: snapshot(parsed.tracks.filter((track) => trackIds.has(track.id)), metadata.localRevision, true) };
}

/** Local annotations never rename native Cue references or fader commands. */
export function ma2EventSnapshotProperties(event: LightingEvent, time: number, muted: boolean, nativeName: string): Ma2SyncObject['properties'] {
  const common = { time: String(time), muted: String(muted) };
  if (event.kind === 'ma2-fader') return { ...common, executor: event.executor, action: 'master', fader: event.fader, level: String(event.level), name: '主推杆' };
  if (event.kind !== 'ma2') throw new Error(`MA2 绑定轨道包含尚未映射的 ${event.kind} 事件`);
  return { ...common, executor: event.executor, action: event.action,
    cue: event.action === 'goto' ? event.cue ?? '' : '', sequence: event.action === 'goto' ? String(event.sequence) : '',
    name: event.action === 'goto' ? nativeName : event.action === 'go' ? '下一步' : '关闭执行器' };
}
