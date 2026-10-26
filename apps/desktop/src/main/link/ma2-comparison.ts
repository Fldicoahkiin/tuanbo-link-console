import { createHash } from 'node:crypto';
import { previewMa2BoundSync, type Ma2SyncPreview } from '@tb/core/link';
import { lightingDocumentSchema, ma2TimecodePreviewSchema, type LightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { inspectMa2TimecodeXml, validateMa2TimecodeWrite } from './ma2-timecode-xml';

export function compareMa2LightingReadback(documentInput: LightingDocument, bindingId: string, readbackInput: Ma2TimecodePreview, choices: ReadonlyMap<string, string | null>): Ma2SyncPreview {
  const document = lightingDocumentSchema.parse(documentInput);
  const readback = ma2TimecodePreviewSchema.parse(readbackInput);
  const binding = document.ma2Bindings?.find((entry) => entry.id === bindingId);
  if (!binding) throw new Error('节目没有这个 MA2 对象绑定');
  binding.trackMappings ??= recoverMa2TrackMappings(binding.sourceXml, binding.timecode, binding.baselineTracks, binding.mappings);
  readback.trackMappings ??= recoverMa2TrackMappings(readback.sourceXml, readback.target, readback.document.tracks, readback.mappings);
  if ((binding.timeOriginMs ?? 0) !== (readback.timeOriginMs ?? 0)) throw new Error('回读与节目时间码起点不一致');
  const baseline = verifySnapshotSource(binding.sourceXml, binding.timecode, binding.baselineTracks, binding.mappings, binding.trackMappings, binding.timeOriginMs ?? 0, binding.nativeEvents ?? []);
  const remote = verifySnapshotSource(readback.sourceXml, readback.target, readback.document.tracks, readback.mappings, readback.trackMappings, readback.timeOriginMs ?? 0, readback.unconverted);
  return previewMa2BoundSync(document, bindingId, readback, choices, {
    baselineVersion: baseline.version, remoteVersion: remote.version,
    baselineRevision: baseline.sha256, remoteRevision: remote.sha256,
    localRevision: createHash('sha256').update(JSON.stringify(document)).digest('hex')
  });
}

/** `consoleOnly`: actions the software does not convert; they stay in the XML and need no mapping. */
function verifySnapshotSource(xml: string, target: number, tracks: LightingDocument['tracks'], mappings: Ma2TimecodePreview['mappings'], trackMappings: Ma2TimecodePreview['trackMappings'], originMs: number, consoleOnly: readonly { path: string }[]) {
  validateMa2TimecodeWrite(xml);
  const report = inspectMa2TimecodeXml(xml);
  const timecode = report.timecodes[0];
  if (report.timecodes.length !== 1 || timecode?.index !== target - 1) throw new Error('同步 XML 与绑定的 Timecode 不一致');
  if (timecode.attributes.frame_format !== '30 FPS' || !/^\d+(?:\.\d+)?$/.test(timecode.attributes.offset ?? '0')) throw new Error('同步 XML 的时间基准尚未验证');
  const source = new Map(timecode.tracks.flatMap((track) => track.subtracks.flatMap((subtrack) => subtrack.events.map((event) => [event.path, { event, subtrack, executor: track.executorAddress.slice(2).join('.') }] as const))));
  const mapped = new Set<string>();
  for (const mapping of mappings) {
    const original = source.get(mapping.path);
    const clip = tracks.find((track) => track.id === mapping.trackId)?.clips.find((entry) => entry.id === mapping.clipId);
    const event = clip?.events.find((entry) => entry.id === mapping.eventId);
    if (!original || mapped.has(mapping.path) || !clip || clip.timeLock !== 'time' || (event?.kind !== 'ma2' && event?.kind !== 'ma2-fader')) throw new Error('同步快照的事件映射与原始 XML 不一致');
    mapped.add(mapping.path);
    const address = original.event.cueAddress;
    const milliseconds = (Number(original.event.attributes.time ?? 0) + Number(timecode.attributes.offset ?? 0)) * 1000 / 30 - originMs;
    if (!Number.isFinite(milliseconds) || Math.abs(clip.start + event.at - milliseconds) > 1e-6 || mapping.executor !== event.executor || original.executor !== event.executor) throw new Error('同步快照的时间或执行器与原始 XML 不一致');
    if (event.kind === 'ma2-fader') {
      const level = original.event.attributes.fader_level;
      if (report.version !== '3.3.4' || original.subtrack.attributes.fader_command !== 'Master' ||
        Object.keys(original.subtrack.attributes).some((key) => !['index', 'fader_command'].includes(key)) ||
        Object.keys(original.event.attributes).some((key) => !['index', 'time', 'fader_level'].includes(key)) ||
        !level || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(level) || Number(level) !== event.level ||
        address.length || original.event.cueName !== null || mapping.action !== 'master' || mapping.sequence !== null || mapping.cueIndex !== null) throw new Error('同步快照的 Master 推杆与原始 XML 不一致');
      continue;
    }
    if (original.subtrack.attributes.fader_command !== undefined || original.event.attributes.fader_level !== undefined) throw new Error('同步快照把原始 XML 推杆转换成了 Cue');
    const action = original.event.attributes.command === 'Goto' ? 'goto' : original.event.attributes.command === 'Go' ? 'go' : original.event.attributes.command === 'Off' ? 'off' : null;
    const validReference = action === 'goto'
      ? address.join('.') === `1.${mapping.sequence}.${mapping.cueIndex}` && mapping.sequence === event.sequence && (mapping.action ?? 'goto') === 'goto'
      : address.length === 0 && original.event.cueName === null && mapping.sequence === null && mapping.cueIndex === null && mapping.action === action;
    if (!Number.isFinite(milliseconds) || Math.abs(clip.start + event.at - milliseconds) > 1e-6 || !validReference || mapping.executor !== event.executor || original.executor !== event.executor || original.event.attributes.pressed !== 'true' || event.action !== action) throw new Error('同步快照的时间或 Cue 引用与原始 XML 不一致');
  }
  const kept = new Set(consoleOnly.map((entry) => entry.path));
  if ([...source.keys()].some((path) => !mapped.has(path) && !kept.has(path))) throw new Error('同步快照未包含原始 XML 的全部事件');
  if (trackMappings) {
    const paths = new Set<string>(); const ids = new Set<string>();
    for (const mapping of trackMappings) {
      const original = timecode.tracks.find((track) => `Timecode:${timecode.index}/Track:${track.index}` === mapping.path);
      const track = tracks.find((entry) => entry.id === mapping.trackId);
      if (!original || !track || paths.has(mapping.path) || ids.has(track.id) || original.executorAddress.slice(2).join('.') !== mapping.executor || track.muted !== (original.attributes.active !== 'true') || track.name !== (original.executorName ?? `MA2 轨道 ${original.index + 1}`) ||
        JSON.stringify(mapping.subtracks) !== JSON.stringify(original.subtracks.map((subtrack) => `${mapping.path}/SubTrack:${subtrack.index}`))) throw new Error('同步轨道映射与原始 XML 不一致');
      paths.add(mapping.path); ids.add(track.id);
      if (mappings.some((event) => event.trackId === track.id && (!event.path.startsWith(`${mapping.path}/`) || event.executor !== mapping.executor))) throw new Error('同步事件所属轨道与原始 XML 不一致');
    }
    if (paths.size !== timecode.tracks.length || ids.size !== tracks.length) throw new Error('同步轨道映射未覆盖原始 XML 全部轨道');
  }
  return report;
}

/** Recover old programme mappings from their exact saved XML, never from the new console state. */
export function recoverMa2TrackMappings(xml: string, target: number, tracks: LightingDocument['tracks'], mappings: Ma2TimecodePreview['mappings']): NonNullable<Ma2TimecodePreview['trackMappings']> {
  const timecode = inspectMa2TimecodeXml(xml).timecodes.find((entry) => entry.index === target - 1);
  if (!timecode || timecode.tracks.length !== tracks.length) throw new Error('旧版轨道映射与原始 XML 数量不一致');
  const used = new Set<number>();
  return tracks.map((track) => {
    const anchors = new Set(mappings.filter((entry) => entry.trackId === track.id).map((entry) => entry.path.slice(0, entry.path.lastIndexOf('/SubTrack:'))));
    const candidates = timecode.tracks.filter((entry) => !used.has(entry.index) && (anchors.size
      ? anchors.size === 1 && anchors.has(`Timecode:${timecode.index}/Track:${entry.index}`)
      : track.name === (entry.executorName ?? `MA2 轨道 ${entry.index + 1}`) && track.muted === (entry.attributes.active !== 'true') && entry.subtracks.every((subtrack) => !subtrack.events.length)));
    if (candidates.length !== 1) throw new Error('旧版空轨道对应不明确，无法自动恢复绑定');
    const native = candidates[0]!; used.add(native.index);
    const path = `Timecode:${timecode.index}/Track:${native.index}`;
    const address = native.executorAddress;
    if (address.length !== 4 || address[0] !== '30' || address[1] !== '1' || !address.slice(2).every((value) => /^[1-9]\d*$/.test(value))) throw new Error('旧版轨道执行器引用无效');
    return { trackId: track.id, path, executor: address.slice(2).join('.'), subtracks: native.subtracks.map((subtrack) => `${path}/SubTrack:${subtrack.index}`) };
  });
}
