import { alignMa2SnapshotToFrames, resolveMa2Readback, resolveMa2ReadbackTracks, resolveMa2Sync, type Ma2SyncChoice } from '@tb/core/link';
import { lightingDocumentSchema, ma2TimecodePreviewSchema, type LightingDocument, type Ma2ConsoleChanges, type Ma2SyncSnapshot, type Ma2TimecodePreview } from '@tb/schema';
import { z } from 'zod';
import { compareMa2LightingReadback, recoverMa2TrackMappings } from './ma2-comparison';
import { editMa2TrackStates, extendMa2TimecodeLength, inspectMa2SequenceXml, inspectMa2TimecodeXml, prepareMa2TimecodeEvents, resolveMa2CueNumber, sameMa2XmlObjects, type Ma2EventEdit } from './ma2-timecode-xml';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { appendMa2MasterSubtracks, appendMa2Tracks, removeMa2Tracks } from './ma2-track-write';

const commonProperties = {
  time: z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().finite().nonnegative().max(86400000)),
  executor: z.string().regex(/^[1-9]\d*\.[1-9]\d*$/), muted: z.literal('false')
};
const eventProperties = z.union([
  z.object({ ...commonProperties, cue: z.string(), name: z.string(), sequence: z.string(), action: z.enum(['goto', 'go', 'off']) }).strict(),
  z.object({ ...commonProperties, name: z.literal('主推杆'), action: z.literal('master'), fader: z.literal('Master'),
    level: z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/).transform(Number).refine((value) => value === Number(value.toFixed(3)), 'MA2 3.3.4 的主推杆精度是 0.1%，请调整推杆值后再同步（这次没有写入控台）') }).strict()
]);

export type Ma2PreparedEventWrite = {
  timeOriginMs?: number | undefined;
  expectedXml: string;
  desiredXml: string;
  desired: Ma2SyncSnapshot;
  eventPaths: Map<string, string>;
  trackPaths: Map<string, string>;
};

/** Compile a reviewed merge. No I/O occurs until every change has been represented. */
export function prepareMa2MergedEvents(documentInput: LightingDocument, bindingId: string, readbackInput: Ma2TimecodePreview,
  identityChoices: ReadonlyMap<string, string | null>, conflictChoices: ReadonlyMap<string, Ma2SyncChoice>, sequenceXml: readonly string[], timeAlignment: 'exact' | 'nearest-frame' = 'exact', consoleChanges: Ma2ConsoleChanges = 'read-back'): Ma2PreparedEventWrite {
  const document = lightingDocumentSchema.parse(documentInput);
  const readback = ma2TimecodePreviewSchema.parse(readbackInput);
  const binding = document.ma2Bindings?.find((entry) => entry.id === bindingId);
  if (!binding) throw new Error('节目没有这个 MA2 对象绑定');
  binding.trackMappings ??= recoverMa2TrackMappings(binding.sourceXml, binding.timecode, binding.baselineTracks, binding.mappings);
  readback.trackMappings ??= recoverMa2TrackMappings(readback.sourceXml, readback.target, readback.document.tracks, readback.mappings);
  const comparison = compareMa2LightingReadback(document, bindingId, readback, identityChoices, consoleChanges);
  const merged = resolveMa2Sync(comparison, conflictChoices);
  const desired = timeAlignment === 'nearest-frame' ? alignMa2SnapshotToFrames(merged, 30, readback.timeOriginMs ?? 0).snapshot : merged;
  const remoteObjects = new Map(comparison.remote.objects.map((object) => [object.id, object]));
  const desiredObjects = new Map(desired.objects.map((object) => [object.id, object]));
  const pendingTracks = new Map((binding.pendingTracks ?? []).map((track) => [track.trackId, track]));
  // Track/object operations require their own native adapters, never silently discard them.
  for (const object of [...comparison.remote.objects, ...desired.objects].filter((object) => object.kind !== 'event')) {
    const remote = remoteObjects.get(object.id); const next = desiredObjects.get(object.id);
    if (remote?.kind === 'track' && !next) continue;
    if (!remote && next?.kind === 'track' && next.parentId === binding.id && pendingTracks.has(next.id) &&
      Object.keys(next.properties).length === 2 && next.properties.name === pendingTracks.get(next.id)!.executorName && ['true', 'false'].includes(next.properties.muted ?? '')) continue;
    if (!remote || !next || remote.kind !== next.kind || remote.parentId !== next.parentId || (object.kind !== 'track' && remote.order !== next.order) ||
      Object.keys(remote.properties).length !== Object.keys(next.properties).length || Object.keys(remote.properties).some((key) => remote.properties[key] !== next.properties[key] && !(object.kind === 'track' && key === 'muted' && ['true', 'false'].includes(next.properties[key] ?? '')))) {
      throw new Error('这次合并改动了轨道或 Timecode 本身，暂时不能写回');
    }
  }
  const matches = resolveMa2Readback(binding, readback, identityChoices);
  const ids = new Map(matches.matches.map((entry) => [entry.remoteEventId, entry.baselineEventId]));
  const paths = new Map<string, string>();
  const subtracks = new Map<string, Set<string>>();
  for (const mapping of readback.mappings) {
    const id = ids.get(mapping.eventId) ?? `remote-event:${mapping.eventId}`;
    const object = remoteObjects.get(id);
    if (!object || object.kind !== 'event' || !object.parentId) throw new Error('回读事件与合并结果的身份不一致');
    paths.set(id, mapping.path);
    const tracks = subtracks.get(object.parentId) ?? new Set<string>();
    tracks.add(mapping.path.slice(0, mapping.path.lastIndexOf('/'))); subtracks.set(object.parentId, tracks);
  }
  const report = inspectMa2TimecodeXml(readback.sourceXml);
  const trackIdentities = resolveMa2ReadbackTracks(binding, readback, matches);
  const trackPaths = new Map<string, string>();
  const trackExecutors = new Map<string, string>();
  const subtrackExecutors = new Map<string, string>();
  const masterSubtracks = new Set<string>();
  for (const track of readback.document.tracks) {
    const stableId = trackIdentities.get(track.id);
    const mapping = readback.trackMappings?.find((entry) => entry.trackId === track.id);
    const eventPath = readback.mappings.find((entry) => entry.trackId === track.id)?.path;
    const path = mapping?.path ?? eventPath?.slice(0, eventPath.lastIndexOf('/SubTrack:'));
    const native = report.timecodes.flatMap((tc) => tc.tracks.map((entry) => ({ path: `Timecode:${tc.index}/Track:${entry.index}`, track: entry }))).find((entry) => entry.path === path);
    if (!stableId || !path || !native) throw new Error('控台轨道的写回映射缺失');
    trackPaths.set(stableId, path);
    trackExecutors.set(stableId, native.track.executorAddress.slice(2).join('.'));
    const candidates = new Set(native.track.subtracks.map((entry) => `${path}/SubTrack:${entry.index}`));
    subtracks.set(stableId, candidates);
    for (const candidate of candidates) subtrackExecutors.set(candidate, native.track.executorAddress.slice(2).join('.'));
    for (const entry of native.track.subtracks) if (entry.attributes.fader_command === 'Master') masterSubtracks.add(`${path}/SubTrack:${entry.index}`);
  }
  const newTracks = desired.objects.filter((object) => object.kind === 'track' && !remoteObjects.has(object.id));
  for (const track of readback.document.tracks) {
    const stableId = trackIdentities.get(track.id);
    const executor = readback.trackMappings?.find((mapping) => mapping.trackId === track.id)?.executor;
    if (!binding.baselineTracks.some((entry) => entry.id === stableId) && newTracks.some((entry) => pendingTracks.get(entry.id)?.executor === executor)) {
      throw new Error('控台上新加的轨道和待同步的轨道用了同一个执行器。请先取消待同步的关联并重新读取控台，避免重复创建');
    }
  }
  const appended = appendMa2Tracks(readback.sourceXml, readback.target, newTracks.map((object) => {
    const pending = pendingTracks.get(object.id);
    if (!pending) throw new Error('新增的轨道没有指定执行器');
    return { executor: pending.executor, executorName: pending.executorName, muted: object.properties.muted === 'true' };
  }));
  for (const [index, track] of newTracks.entries()) {
    const path = appended.paths[index]; const pending = pendingTracks.get(track.id);
    if (!path || !pending) throw new Error('新增轨道写回映射缺失');
    trackPaths.set(track.id, path);
    trackExecutors.set(track.id, pending.executor);
    const subtrack = `${path}/SubTrack:0`;
    subtracks.set(track.id, new Set([subtrack])); subtrackExecutors.set(subtrack, pending.executor);
  }
  const neededMasters = new Set(desired.objects.filter((object) => object.kind === 'event' && object.properties.action === 'master').map((object) => object.parentId));
  const newMasters = appendMa2MasterSubtracks(appended.xml, readback.target, [...trackPaths].filter(([id]) => neededMasters.has(id) && ![...(subtracks.get(id) ?? [])].some((path) => masterSubtracks.has(path))).map(([, path]) => path));
  for (const [id, path] of trackPaths) {
    const master = newMasters.paths.get(path); if (!master) continue;
    const executor = trackExecutors.get(id);
    if (!executor) throw new Error('新增的推杆子轨道没有指定执行器');
    subtracks.get(id)!.add(master); masterSubtracks.add(master); subtrackExecutors.set(master, executor);
  }
  const raw = new Map(report.timecodes.flatMap((tc) => tc.tracks.flatMap((track) => track.subtracks.flatMap((subtrack) => subtrack.events.map((event) => [event.path, { event, executor: track.executorAddress.slice(2).join('.') }] as const)))));
  // Console actions the software does not convert stay in the XML untouched (2026-10-26); the ones shown
  // on the timeline (a Cue with console-only parameters) may only move or be deleted.
  const consoleOnly = new Set(readback.unconverted.map((entry) => entry.path));
  const followers = ma2ReleaseFollowers(report);
  const sequences = sequenceXml.map((source) => inspectMa2SequenceXml(source, true));
  if (sequences.some((sequence) => sequence.version !== report.version)) throw new Error('关联序列的 MA2 版本与 Timecode 不一致');
  const edits: Ma2EventEdit[] = [];
  const addedIds = new Map<number, string>();
  for (const [id, path] of paths) if (!desiredObjects.has(id)) edits.push({ kind: 'delete', path });
  for (const object of desired.objects.filter((entry) => entry.kind === 'event')) {
    const level = Number(object.properties.level);
    if (object.properties.action === 'master' && Number.isFinite(level) && level !== Number(level.toFixed(3))) {
      throw new Error('MA2 3.3.4 的主推杆精度是 0.1%，请调整推杆值后再同步（这次没有写入控台）');
    }
    const properties = eventProperties.safeParse(object.properties);
    if (!properties.success || object.order !== 0 || !object.parentId) throw new Error('这次合并里有还不支持的灯光动作或参数');
    const value = properties.data;
    let path = paths.get(object.id);
    const before = remoteObjects.get(object.id);
    if (path && before && before.parentId !== object.parentId) {
      edits.push({ kind: 'delete', path });
      path = undefined;
    }
    const candidates = new Set([...(subtracks.get(object.parentId) ?? [])].filter((candidate) => masterSubtracks.has(candidate) === (value.action === 'master')));
    const subtrackPath = path?.slice(0, path.lastIndexOf('/')) ?? (candidates?.size === 1 ? [...candidates][0] : undefined);
    if (!subtrackPath) throw new Error('新增灯光点要放到控台哪条子轨道不明确');
    const original = path ? raw.get(path) : undefined;
    const executor = original?.executor ?? subtrackExecutors.get(subtrackPath);
    if (executor !== value.executor) throw new Error('灯光点的执行器和控台轨道对不上，请先设置轨道对应关系');
    if (masterSubtracks.has(subtrackPath) !== (value.action === 'master')) throw new Error('不能把 Cue 点改成推杆点，或把推杆点改成 Cue 点');
    const ticks = (value.time + (readback.timeOriginMs ?? 0)) * 30 / 1000 - Number(report.timecodes[0]?.attributes.offset ?? 0);
    if (ticks < 0) throw new Error('事件比控台 Timecode 的起点还早，请调整时间，或在控台修改偏移');
    // Current native acceptance proves integer ticks. Do not silently round sub-frame points.
    if (Math.abs(ticks - Math.round(ticks)) > 1e-7) throw new Error('灯光点的时间没有对齐到 MA2 的帧，请先对齐帧');
    const rawTime = String(Math.round(ticks));
    if (value.action === 'master') {
      if (path && original) {
        const timeChanged = Number(original.event.attributes.time ?? 0) !== Number(rawTime);
        const levelChanged = Number(original.event.attributes.fader_level) !== value.level;
        if (timeChanged || levelChanged) edits.push({ kind: 'update', path, ...(timeChanged ? { rawTime } : {}), ...(levelChanged ? { faderLevel: String(value.level) } : {}) });
      } else {
        addedIds.set(edits.length, object.id); edits.push({ kind: 'add', subtrackPath, rawTime, faderLevel: String(value.level) });
      }
      continue;
    }
    let cue: { sequence: number; cueIndex: number; name: string } | undefined;
    if (value.action === 'goto') {
      if (!/^[1-9]\d*$/.test(value.sequence) || Number(value.sequence) > 99999) throw new Error('调用指定 Cue 必须填写有效序列');
      const reference = resolveMa2CueNumber(Number(value.sequence), value.cue, sequences);
      const sameReference = original?.event.cueAddress.join('.') === `1.${reference.sequence}.${reference.cueIndex}`;
      const name = reference.cueName ?? (sameReference ? original?.event.cueName : null) ?? `Cue ${Number(reference.cueNumber)}`;
      // A programme label is an annotation, never an instruction to rename a console Cue.
      object.properties.name = name;
      // Native references use getobj.name (label plus number), while editor labels
      // use the Sequence export's Cue name without the numeric suffix.
      cue = { sequence: reference.sequence, cueIndex: reference.cueIndex, name: reference.cueName === null ? name : `${reference.cueName} ${Number(reference.cueNumber)}` };
    } else if (value.cue || value.sequence) throw new Error('执行器动作不能带有 Cue 引用');
    if (path && original) {
      const timeChanged = Number(original.event.attributes.time ?? 0) !== Number(rawTime);
      const cueChanged = cue ? original.event.cueAddress.join('.') !== `1.${cue.sequence}.${cue.cueIndex}` || original.event.attributes.command !== 'Goto' : false;
      const actionChanged = value.action !== 'goto' && original.event.attributes.command !== (value.action === 'go' ? 'Go' : 'Off');
      if ((cueChanged || actionChanged) && consoleOnly.has(path)) throw new Error(`没有写入控台：事件 ${path} 带有联动台不转换的控台参数，在联动台里只能改时间或删除。要换 Cue 或动作，请在控台上改。`);
      if (timeChanged || cueChanged || actionChanged) edits.push({ kind: 'update', path, ...(timeChanged ? { rawTime } : {}), ...(cueChanged ? { cue } : {}), ...(actionChanged && value.action !== 'goto' ? { executorAction: value.action } : {}) });
    } else {
      addedIds.set(edits.length, object.id); edits.push({ kind: 'add', subtrackPath, rawTime, ...(cue ? { cue } : {}), ...(value.action !== 'goto' ? { executorAction: value.action } : {}) });
    }
  }
  edits.push(...ma2FollowerEdits(edits, followers, raw));
  const write = prepareMa2TimecodeEvents(newMasters.xml, inspectMa2TimecodeXml(newMasters.xml).sha256, readback.target, edits);
  const eventPaths = new Map<string, string>();
  for (const [id, path] of paths) { const next = write.originalPaths.get(path); if (next) eventPaths.set(id, next); }
  for (const [index, id] of addedIds) { const path = write.addedPaths.get(index); if (!path) throw new Error('新增灯光点的写回映射缺失'); eventPaths.set(id, path); }
  if (eventPaths.size !== desired.objects.filter((object) => object.kind === 'event').length) throw new Error('写回映射未覆盖所有灯光点');
  const trackEdits = desired.objects.filter((entry) => entry.kind === 'track' && entry.properties.muted !== remoteObjects.get(entry.id)?.properties.muted).map((entry) => {
    const path = trackPaths.get(entry.id);
    if (!path) throw new Error('轨道静音修改缺少控台映射');
    return { path, muted: entry.properties.muted === 'true' };
  });
  const deletedPaths = [...trackPaths].filter(([id]) => !desiredObjects.has(id)).map(([, path]) => path);
  for (const path of deletedPaths) {
    if ([...consoleOnly].some((entry) => entry === path || entry.startsWith(`${path}/`))) throw new Error('没有写入控台：这条轨道上有联动台不转换的控台动作。要删掉整条轨道，请在控台上删。');
  }
  const orderedTracks = desired.objects.filter((entry) => entry.kind === 'track').sort((a, b) => a.order - b.order);
  if (orderedTracks.some((track, index) => track.order !== index)) throw new Error('合并后的轨道顺序有冲突，请重新比较');
  const order = orderedTracks.map((track) => { const path = trackPaths.get(track.id); if (!path) throw new Error('轨道排序缺少控台映射'); return path; });
  const removed = removeMa2Tracks(editMa2TrackStates(write.xml, readback.target, trackEdits), readback.target, deletedPaths, order);
  for (const [id, previous] of trackPaths) {
    const next = removed.trackPaths.get(previous);
    if (next) trackPaths.set(id, next); else trackPaths.delete(id);
  }
  for (const [id, previous] of eventPaths) {
    const split = previous.indexOf('/SubTrack:');
    const next = removed.trackPaths.get(previous.slice(0, split));
    if (!next) throw new Error('删除轨道后还有灯光点关联着它');
    eventPaths.set(id, next + previous.slice(split));
  }
  const desiredXml = edits.length ? extendMa2TimecodeLength(removed.xml, readback.target) : removed.xml;
  return { expectedXml: readback.sourceXml, desiredXml, desired, eventPaths, trackPaths, timeOriginMs: readback.timeOriginMs };
}

/** Confirm native output and restore stable IDs before a project baseline may advance. */
export function confirmMa2MergedEvents(prepared: Ma2PreparedEventWrite, readbackXml: string, sequenceXml: readonly string[]): Ma2TimecodePreview {
  if (!sameMa2XmlObjects(prepared.desiredXml, readbackXml)) throw new Error('控台读回的内容和这次写入的不一致，同步没有完成');
  const root = prepared.desired.objects.find((object) => object.kind === 'timecode');
  if (!root) throw new Error('同步结果缺少 Timecode');
  // Console-only actions are allowed: the readback equals the XML written, so they are kept as they were.
  const preview = convertMa2Timecode(readbackXml, sequenceXml, Number(root.properties.number), prepared.timeOriginMs);
  const byPath = new Map([...prepared.eventPaths].map(([id, path]) => [path, id]));
  if (byPath.size !== prepared.eventPaths.size || byPath.size !== preview.mappings.length) throw new Error('MA2 写回映射数量不一致');
  const desired = new Map(prepared.desired.objects.map((object) => [object.id, object]));
  const mappings = new Map(preview.mappings.map((mapping) => [mapping.eventId, mapping]));
  const trackIds = new Set<string>();
  const tracksByPath = new Map([...prepared.trackPaths].map(([id, path]) => [path, id]));
  if (tracksByPath.size !== prepared.trackPaths.size) throw new Error('MA2 写回轨道映射重复');
  for (const track of preview.document.tracks) {
    const trackMapping = preview.trackMappings?.find((entry) => entry.trackId === track.id);
    const stableTrackId = trackMapping ? tracksByPath.get(trackMapping.path) : undefined;
    if (!stableTrackId || !trackMapping) throw new Error('控台读回的轨道和这次写入对不上');
    for (const clip of track.clips) for (const event of clip.events) {
      const mapping = mappings.get(event.id);
      const id = mapping ? byPath.get(mapping.path) : undefined;
      const expected = id ? desired.get(id) : undefined;
      if (!mapping || !id || !expected || expected.kind !== 'event' || !expected.parentId || (event.kind !== 'ma2' && event.kind !== 'ma2-fader')) throw new Error('控台读回的事件和这次写入对不上');
      const value = eventProperties.parse(expected.properties);
      const actionMatches = value.action === 'master'
        ? event.kind === 'ma2-fader' && event.fader === value.fader && event.level === value.level
        : event.kind === 'ma2' && event.action === value.action && (value.action !== 'goto' || (Number(event.cue) === Number(value.cue) && event.sequence === Number(value.sequence)));
      if (Math.abs(event.at + clip.start - value.time) > 1e-6 || !actionMatches || event.executor !== value.executor || event.label !== value.name || clip.muted !== (value.muted !== 'false')) throw new Error('控台读回的时间、Cue 或动作和合并结果对不上');
      if (stableTrackId && stableTrackId !== expected.parentId) throw new Error('控台读回的轨道关系对不上');
      event.id = id; mapping.eventId = id; mapping.trackId = expected.parentId;
    }
    if (!stableTrackId || trackIds.has(stableTrackId)) throw new Error('控台读回的轨道无法一一对应');
    const expected = desired.get(stableTrackId);
    if (expected?.kind !== 'track' || expected.order !== trackIds.size || expected.properties.name !== track.name || expected.properties.muted !== String(track.muted)) throw new Error('控台读回的轨道属性和合并结果对不上');
    trackIds.add(stableTrackId); track.id = stableTrackId; trackMapping.trackId = stableTrackId;
  }
  if (root.properties.name !== preview.name || trackIds.size !== prepared.desired.objects.filter((object) => object.kind === 'track').length) throw new Error('控台读回的对象范围和合并结果对不上');
  return ma2TimecodePreviewSchema.parse(preview);
}

/**
 * A button press recorded on the console is followed by its release (`pressed="false"`) on the same
 * SubTrack. Each release belongs to the nearest earlier press of the same command and Cue; it is not
 * shown in the software and moves or goes with its press.
 */
export function ma2ReleaseFollowers(report: Pick<ReturnType<typeof inspectMa2TimecodeXml>, 'timecodes'>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const tc of report.timecodes) for (const track of tc.tracks) for (const subtrack of track.subtracks) {
    const last = new Map<string, string>();
    const ordered = subtrack.events.map((event, position) => ({ event, position }))
      .sort((a, b) => Number(a.event.attributes.time ?? 0) - Number(b.event.attributes.time ?? 0) || a.position - b.position);
    for (const { event } of ordered) {
      if (event.attributes.fader_level !== undefined) continue;
      const key = `${event.attributes.command ?? ''}|${event.cueAddress.join('.')}`;
      if (event.attributes.pressed === 'true') last.set(key, event.path);
      else if (event.attributes.pressed === 'false') {
        const press = last.get(key);
        if (press) result.set(press, [...result.get(press) ?? [], event.path]);
      }
    }
  }
  return result;
}

/** A press that moves takes its releases along by the same amount; a press deleted takes them with it. */
export function ma2FollowerEdits(edits: readonly Ma2EventEdit[], followers: ReadonlyMap<string, readonly string[]>, raw: ReadonlyMap<string, { event: { attributes: Record<string, string> } }>): Ma2EventEdit[] {
  const touched = new Set(edits.flatMap((edit) => edit.kind === 'add' ? [] : [edit.path]));
  const result: Ma2EventEdit[] = [];
  for (const edit of edits) {
    if (edit.kind === 'add') continue;
    const paths = (followers.get(edit.path) ?? []).filter((path) => !touched.has(path));
    if (edit.kind === 'delete') { for (const path of paths) { touched.add(path); result.push({ kind: 'delete', path }); } continue; }
    if (edit.rawTime === undefined) continue;
    const before = Number(raw.get(edit.path)?.event.attributes.time ?? 0);
    const shift = Number(edit.rawTime) - before;
    if (!Number.isFinite(shift) || shift === 0) continue;
    for (const path of paths) {
      const time = Number(raw.get(path)?.event.attributes.time ?? 0) + shift;
      if (!Number.isFinite(time) || time < 0) throw new Error(`没有写入控台：按键松开事件 ${path} 跟着按下移动后，早于时间线起点。`);
      touched.add(path);
      result.push({ kind: 'update', path, rawTime: String(Number(time.toFixed(6))) });
    }
  }
  return result;
}
