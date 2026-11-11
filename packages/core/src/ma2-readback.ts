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
    if (candidates.size > 1) throw new Error('控台上的一条轨道对不上联动台里的轨道：联动台里有几条轨道用同一个执行器，这次没有同步。可以在「同步状态详情」里点“用控台上的”');
    const id = [...candidates][0] ?? `remote-track:${track.id}`;
    if (used.has(id)) throw new Error('多个控台轨道对上了联动台里的同一条轨道，这次没有同步。可以在「同步状态详情」里点“用控台上的”');
    used.add(id); result.set(track.id, id);
  }
  return result;
}
export type Ma2ReadbackMatch = {
  matches: Array<{ baselineEventId: string; remoteEventId: string }>;
  added: string[];
  deleted: string[];
};

/**
 * Native event indices are positions, not stable identities, so the console's events are matched to
 * the confirmed baseline by what they call: executor, Sequence, Cue and action. A group with one event
 * on each side pairs even when it moved. In a group with repeats, events at an unchanged absolute time
 * pair first; the rest pair automatically (2026-11-11, the user: "我要的是软件能实时同步控台做出的修改",
 * nobody confirms which is which): both sides in time order, equal counts in order, unequal counts by the
 * order-preserving pairing with the smallest total time distance, and what is left over was added on
 * the console or deleted there. Every event of a group is the same Cue call, so the pairing only decides
 * which local event keeps which identity; the console's times and the set of calls come out the same
 * whichever way it pairs.
 */
export function matchMa2Readback(bindingInput: Binding, previewInput: Ma2TimecodePreview): Ma2ReadbackMatch {
  const binding = lightingMa2BindingSchema.parse(bindingInput);
  const preview = ma2TimecodePreviewSchema.parse(previewInput);
  if (binding.timecode !== preview.target) throw new Error('读回的 Timecode 和节目绑定对不上');
  if ((binding.timeOriginMs ?? 0) !== (preview.timeOriginMs ?? 0)) throw new Error('读回的歌曲时间码起点和绑定对不上');
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
  const result: Ma2ReadbackMatch = { matches: [], added: [], deleted: [] };
  for (const reference of new Set([...baselineGroups.keys(), ...remoteGroups.keys()])) {
    let ours = baselineGroups.get(reference) ?? []; let theirs = remoteGroups.get(reference) ?? [];
    const matchedBase = new Set<string>(); const matchedRemote = new Set<string>();
    const pair = (a: Entry, b: Entry): void => {
      result.matches.push({ baselineEventId: a.mapping.eventId, remoteEventId: b.mapping.eventId });
      matchedBase.add(a.mapping.eventId); matchedRemote.add(b.mapping.eventId);
    };
    // Repeated Cues are anchored first by unambiguous, unchanged absolute times.
    if (ours.length > 1 || theirs.length > 1) {
      const byTime = (entries: Entry[]): Map<number, Entry[]> => {
        const index = new Map<number, Entry[]>();
        for (const entry of entries) { const group = index.get(entry.time) ?? []; group.push(entry); index.set(entry.time, group); }
        return index;
      };
      const remoteTimes = byTime(theirs);
      for (const [time, entries] of byTime(ours)) {
        const candidates = remoteTimes.get(time);
        if (entries.length === 1 && candidates?.length === 1) pair(entries[0]!, candidates[0]!);
      }
    }
    ours = ours.filter((entry) => !matchedBase.has(entry.mapping.eventId));
    theirs = theirs.filter((entry) => !matchedRemote.has(entry.mapping.eventId));
    for (const [a, b] of pairInOrder(ours, theirs)) pair(a, b);
    result.added.push(...theirs.filter((entry) => !matchedRemote.has(entry.mapping.eventId)).map((entry) => entry.mapping.eventId));
    result.deleted.push(...ours.filter((entry) => !matchedBase.has(entry.mapping.eventId)).map((entry) => entry.mapping.eventId));
  }
  return result;
}

/**
 * The order-preserving pairing of two runs of the same Cue call with the smallest total time distance;
 * equal counts pair in time order. Ties keep the earlier events together, so the result never depends on
 * how the console happened to number its events.
 */
function pairInOrder(oursInput: readonly Entry[], theirsInput: readonly Entry[]): Array<[Entry, Entry]> {
  const sorted = (entries: readonly Entry[]): Entry[] => entries.map((entry, position) => ({ entry, position })).sort((a, b) => a.entry.time - b.entry.time || a.position - b.position).map(({ entry }) => entry);
  const ours = sorted(oursInput); const theirs = sorted(theirsInput);
  if (ours.length === theirs.length) return ours.map((entry, index) => [entry, theirs[index]!]);
  const swap = ours.length > theirs.length;
  const short = swap ? theirs : ours; const long = swap ? ours : theirs;
  // cost[i][j]: the best pairing of the first i short events within the first j long ones (j ≥ i).
  const cost = Array.from({ length: short.length + 1 }, () => new Array<number>(long.length + 1).fill(Number.POSITIVE_INFINITY));
  for (let j = 0; j <= long.length; j += 1) cost[0]![j] = 0;
  const take = (i: number, k: number): number => cost[i - 1]![k - 1]! + Math.abs(short[i - 1]!.time - long[k - 1]!.time);
  for (let i = 1; i <= short.length; i += 1) for (let k = i; k <= long.length; k += 1) cost[i]![k] = Math.min(take(i, k), cost[i]![k - 1]!);
  const result: Array<[Entry, Entry]> = [];
  let j = long.length;
  for (let i = short.length; i > 0; i -= 1) {
    // Walking back from the end, a later long event is left over whenever that is at least as good.
    while (j > i && cost[i]![j - 1]! <= take(i, j)) j -= 1;
    result.push(swap ? [long[j - 1]!, short[i - 1]!] : [short[i - 1]!, long[j - 1]!]);
    j -= 1;
  }
  return result.reverse();
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
