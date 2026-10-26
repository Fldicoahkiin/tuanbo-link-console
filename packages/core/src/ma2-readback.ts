import { lightingMa2BindingSchema, ma2TimecodePreviewSchema, type LightingDocument, type LightingTrack, type Ma2TimecodePreview } from '@tb/schema';

type Binding = NonNullable<LightingDocument['ma2Bindings']>[number];
type Mapping = Binding['mappings'][number];
type Entry = { mapping: Mapping; time: number };

/** Match native tracks independently of their events, including empty tracks. */
export function resolveMa2ReadbackTracks(binding: Binding, preview: Ma2TimecodePreview, matches: Ma2ReadbackMatch): Map<string, string> {
  const oldEvents = new Map(binding.mappings.map((entry) => [entry.eventId, entry.trackId]));
  const identities = new Map(matches.matches.map((entry) => [entry.remoteEventId, entry.baselineEventId]));
  const byExecutor = new Map<string, Set<string>>();
  for (const entry of [...binding.mappings, ...binding.trackMappings ?? []]) {
    const tracks = byExecutor.get(entry.executor) ?? new Set<string>();
    tracks.add(entry.trackId); byExecutor.set(entry.executor, tracks);
  }
  const result = new Map<string, string>(); const used = new Set<string>();
  for (const track of preview.document.tracks) {
    const references = preview.mappings.filter((entry) => entry.trackId === track.id);
    const anchors = new Set(references.flatMap((entry) => {
      const old = identities.get(entry.eventId); const trackId = old ? oldEvents.get(old) : undefined;
      return trackId ? [trackId] : [];
    }));
    const executors = new Set([...references, ...preview.trackMappings?.filter((entry) => entry.trackId === track.id) ?? []].map((entry) => entry.executor));
    if (executors.size !== 1) throw new Error('控台轨道执行器对应缺失或不明确');
    const candidates = anchors.size ? anchors : byExecutor.get([...executors][0]!) ?? new Set<string>();
    if (candidates.size > 1) throw new Error('控台轨道对应不明确，需要确认轨道关系');
    const id = [...candidates][0] ?? `remote-track:${track.id}`;
    if (used.has(id)) throw new Error('多个控台轨道不能自动合并到同一个本地轨道');
    used.add(id); result.set(track.id, id);
  }
  return result;
}
export type Ma2ReadbackMatch = {
  matches: Array<{ baselineEventId: string; remoteEventId: string }>;
  added: string[];
  deleted: string[];
  ambiguous: Array<{ reference: string; baselineEventIds: string[]; remoteEventIds: string[] }>;
};

/** Native event indices are positions, not stable identities. */
export function matchMa2Readback(bindingInput: Binding, previewInput: Ma2TimecodePreview): Ma2ReadbackMatch {
  const binding = lightingMa2BindingSchema.parse(bindingInput);
  const preview = ma2TimecodePreviewSchema.parse(previewInput);
  if (binding.timecode !== preview.target) throw new Error('读回的 Timecode 和节目绑定对不上');
  if ((binding.timeOriginMs ?? 0) !== (preview.timeOriginMs ?? 0)) throw new Error('读回的歌曲时间码起点和绑定对不上');
  if (preview.unconverted.length) throw new Error('读回的数据里有还不支持的事件，无法完整比较');
  const before = mappedEntries(binding.baselineTracks, binding.mappings);
  const remote = mappedEntries(preview.document.tracks, preview.mappings);
  const groups = (entries: Entry[]): Map<string, Entry[]> => {
    const result = new Map<string, Entry[]>();
    for (const entry of entries) {
      const key = JSON.stringify([entry.mapping.executor, entry.mapping.sequence, entry.mapping.cueIndex, entry.mapping.action ?? 'goto']);
      const group = result.get(key) ?? []; group.push(entry); result.set(key, group);
    }
    return result;
  };
  const baselineGroups = groups(before); const remoteGroups = groups(remote);
  const result: Ma2ReadbackMatch = { matches: [], added: [], deleted: [], ambiguous: [] };
  for (const reference of new Set([...baselineGroups.keys(), ...remoteGroups.keys()])) {
    let ours = baselineGroups.get(reference) ?? []; let theirs = remoteGroups.get(reference) ?? [];
    const matchedBase = new Set<string>(); const matchedRemote = new Set<string>();
    const pair = (a: Entry, b: Entry): void => {
      result.matches.push({ baselineEventId: a.mapping.eventId, remoteEventId: b.mapping.eventId });
      matchedBase.add(a.mapping.eventId); matchedRemote.add(b.mapping.eventId);
    };
    // A unique Cue reference can move without changing its identity.
    if (ours.length === 1 && theirs.length === 1) pair(ours[0]!, theirs[0]!);
    else {
      // Repeated Cues are anchored by unambiguous, unchanged absolute times.
      const byTime = (entries: Entry[]): Map<number, Entry[]> => {
        const index = new Map<number, Entry[]>();
        for (const entry of entries) { const group = index.get(entry.time) ?? []; group.push(entry); index.set(entry.time, group); }
        return index;
      };
      const baseTimes = byTime(ours); const remoteTimes = byTime(theirs);
      for (const [time, entries] of baseTimes) {
        const candidates = remoteTimes.get(time);
        if (entries.length === 1 && candidates?.length === 1) pair(entries[0]!, candidates[0]!);
      }
    }
    ours = ours.filter((entry) => !matchedBase.has(entry.mapping.eventId));
    theirs = theirs.filter((entry) => !matchedRemote.has(entry.mapping.eventId));
    if (!ours.length) result.added.push(...theirs.map((entry) => entry.mapping.eventId));
    else if (!theirs.length) result.deleted.push(...ours.map((entry) => entry.mapping.eventId));
    else result.ambiguous.push({ reference, baselineEventIds: ours.map((entry) => entry.mapping.eventId), remoteEventIds: theirs.map((entry) => entry.mapping.eventId) });
  }
  return result;
}

export function resolveMa2Readback(binding: Binding, preview: Ma2TimecodePreview, choices: ReadonlyMap<string, string | null>): Ma2ReadbackMatch {
  const result = matchMa2Readback(binding, preview);
  const pending = new Set(result.ambiguous.flatMap((group) => group.remoteEventIds));
  for (const id of choices.keys()) if (!pending.has(id)) throw new Error('对应选择已过期，请重新读取');
  const used = new Set(result.matches.map((match) => match.baselineEventId));
  for (const group of result.ambiguous) {
    for (const remoteEventId of group.remoteEventIds) {
      if (!choices.has(remoteEventId)) throw new Error('请确认所有待对应的灯光点');
      const baselineEventId = choices.get(remoteEventId);
      if (baselineEventId === null) { result.added.push(remoteEventId); continue; }
      if (!baselineEventId || !group.baselineEventIds.includes(baselineEventId)) throw new Error('所选旧点不属于当前 Cue 候选');
      if (used.has(baselineEventId)) throw new Error('一个旧点不能对应多个控台点');
      used.add(baselineEventId); result.matches.push({ baselineEventId, remoteEventId });
    }
    result.deleted.push(...group.baselineEventIds.filter((id) => !used.has(id)));
  }
  result.ambiguous = [];
  return result;
}

function mappedEntries(tracks: LightingTrack[], mappings: Mapping[]): Entry[] {
  const events = new Map<string, { trackId: string; clipId: string; time: number }>();
  for (const track of tracks) for (const clip of track.clips) {
    if (clip.timeLock !== 'time') throw new Error('控台快照必须使用绝对时间');
    for (const event of clip.events) {
      if ((event.kind !== 'ma2' && event.kind !== 'ma2-fader') || events.has(event.id)) throw new Error('控台事件类型或身份无效');
      events.set(event.id, { trackId: track.id, clipId: clip.id, time: clip.start + event.at });
    }
  }
  const ids = new Set<string>(); const paths = new Set<string>();
  const result = mappings.map((mapping) => {
    const event = events.get(mapping.eventId);
    if (!event || event.trackId !== mapping.trackId || event.clipId !== mapping.clipId || ids.has(mapping.eventId) || paths.has(mapping.path)) throw new Error('控台事件映射缺失或重复');
    ids.add(mapping.eventId); paths.add(mapping.path);
    return { mapping, time: event.time };
  });
  if (ids.size !== events.size) throw new Error('控台快照存在未映射事件');
  return result;
}
