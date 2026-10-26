import { createLightingDocument, lightingDocumentSchema, ma2ExecutorPreviewSchema, ma2TimecodePreviewSchema, parseLinkProject, type LightingDocument, type LightingTrack, type Ma2ExecutorPreview, type Ma2TimecodePreview } from '@tb/schema';
import type { LinkCommand } from './link-command';
import { LightingTempoMap } from './lighting-edit';
import { programTimeOrigin, withMa2TimeOrigin } from './ma2-time-origin';

export function importMa2TimecodeCommand(itemId: string, value: Ma2TimecodePreview, initialDocument?: LightingDocument): LinkCommand {
  const input = ma2TimecodePreviewSchema.parse(value);
  const initial = initialDocument ? lightingDocumentSchema.parse(initialDocument) : undefined;
  const bindingId = crypto.randomUUID();
  return { id: crypto.randomUUID(), label: '从 MA2 加入灯光编排', execute(project) {
    const next = structuredClone(project);
    const item = next.rundown.find((entry) => entry.id === itemId);
    if (!item) throw new Error('接收 MA2 数据的节目不存在');
    const originMs = programTimeOrigin(item, input.timeOriginMs ?? 0);
    if (input.timing?.absoluteEventTimesMs.some(time => time < originMs - 1e-6 || item.referenceAudio && time >= originMs + item.referenceAudio.durationMs)) throw new Error('原生事件超出歌曲原始时间范围，请核对配对；未丢弃事件或改写起点');
    const preview = withMa2TimeOrigin(input, originMs);
    if (originMs > 0) item.playback ??= { volume: item.p1Media?.volume ?? 100, startMs: 0, endMs: 0, mtcOffsetMs: originMs, shortcut: item.p1Media?.shortcut ?? '' };
    const current = item.lighting ?? structuredClone(initial ?? createLightingDocument());
    if (input.unconverted.length && current.outputMode !== 'timecode' && current.tracks.length) throw new Error('含原生保留事件的时间线需要时间码输出；请先核对当前歌曲的直接输出编排');
    if (current.ma2Bindings?.some((binding) => binding.timecode === preview.target)) throw new Error('该节目已关联此 Timecode，请勿重复导入');
    const tracks = structuredClone(preview.document.tracks);
    const templates = [...current.templates];
    for (const track of tracks) for (const clip of track.clips) for (const event of clip.events) {
      if (event.kind !== 'ma2' || event.action !== 'goto' || !event.sequence || !event.cue) continue;
      if (templates.some(template => template.track.cueStamp?.mode === 'fixed' && template.track.cueStamp.sequence === event.sequence && Number(template.track.cueStamp.cue) === Number(event.cue) && template.track.cueStamp.executor === event.executor)) continue;
      const name = event.label || `Cue ${event.cue}`;
      templates.push({ id: crypto.randomUUID(), name, categories: [], track: { ...track, id: crypto.randomUUID(), name, muted: false, solo: false, locked: false, clips: [], cueStamp: { mode: 'fixed', sequence: event.sequence, cue: event.cue, executor: event.executor } } });
    }
    item.lighting = { ...current, ...(input.unconverted.length ? { outputMode: 'timecode' as const } : {}), templates, tracks: [...current.tracks, ...tracks], ma2Bindings: [...current.ma2Bindings ?? [], {
      nativeEvents: structuredClone(preview.unconverted), playback: preview.unconverted.length ? 'native-timecode' : 'editable',
      id: bindingId, timecode: preview.target, name: preview.name, readAt: preview.readAt, timeOriginMs: preview.timeOriginMs,
      sourceXml: preview.sourceXml, baselineTracks: structuredClone(tracks), mappings: structuredClone(preview.mappings), trackMappings: preview.trackMappings?.length === tracks.length ? structuredClone(preview.trackMappings) : undefined, cueCatalog: structuredClone(preview.cueCatalog)
    }] };
    next.schemaVersion = 2;
    next.updatedAt = new Date().toISOString();
    return parseLinkProject(next);
  }, undo: (before) => parseLinkProject(before) };
}

export function bindMa2TrackCommand(itemId: string, bindingId: string, trackId: string, executor: string, executorName: string, executorInput?: Ma2ExecutorPreview): LinkCommand {
  const preview = executorInput ? ma2ExecutorPreviewSchema.parse(executorInput) : undefined;
  return { id: crypto.randomUUID(), label: '关联灯光轨道到 MA2', execute(project) {
    const next = structuredClone(project);
    const document = next.rundown.find((item) => item.id === itemId)?.lighting;
    const binding = document?.ma2Bindings?.find((entry) => entry.id === bindingId);
    const track = document?.tracks.find((entry) => entry.id === trackId);
    if (!document || !binding || !track || track.kind !== 'ma2') throw new Error('请选择节目中的 MA2 灯光轨道和 Timecode 绑定');
    if (preview && (preview.target !== binding.timecode || preview.executor !== executor || preview.executorName !== executorName)) throw new Error('执行器读取结果与所选轨道绑定不一致');
    if (track.locked) throw new Error('请先解锁灯光轨道');
    if (track.cueStamp?.mode === 'fixed' && track.cueStamp.executor !== executor) throw new Error('固定 Cue 的执行器与选定执行器不一致，请先修改灯光打点设置');
    if (document.ma2Bindings?.some((entry) => entry.baselineTracks.some((value) => value.id === trackId) || entry.pendingTracks?.some((value) => value.trackId === trackId))) throw new Error('该灯光轨道已经关联 MA2');
    if (track.clips.some((clip) => clip.events.some((event) => (event.kind !== 'ma2' && event.kind !== 'ma2-fader') || event.executor !== executor))) throw new Error('轨道内的动作必须使用选定执行器');
    binding.pendingTracks = [...binding.pendingTracks ?? [], { trackId, executor, executorName, ...(preview ? { sequence: preview.cueCatalog[0]!.sequence } : {}) }];
    if (preview) binding.cueCatalog = [...new Map([...(binding.cueCatalog ?? []), ...structuredClone(preview.cueCatalog)].map((sequence) => [sequence.sequence, sequence])).values()];
    lightingDocumentSchema.parse(document);
    next.schemaVersion = 2; next.updatedAt = new Date().toISOString();
    return parseLinkProject(next);
  }, undo: (before) => parseLinkProject(before) };
}

/** Apply only an adapter-confirmed readback. The captured document prevents overwriting newer edits. */
export function applyMa2ReadbackCommand(itemId: string, bindingId: string, expectedInput: LightingDocument, confirmedInput: Ma2TimecodePreview, preserveLaterEdits = false): LinkCommand {
  const expected = lightingDocumentSchema.parse(expectedInput);
  const confirmed = ma2TimecodePreviewSchema.parse(confirmedInput);
  const binding = expected.ma2Bindings?.find((entry) => entry.id === bindingId);
  if (!binding || binding.timecode !== confirmed.target) throw new Error('MA2 回读与节目绑定不一致');
  if ((binding.timeOriginMs ?? 0) !== (confirmed.timeOriginMs ?? 0)) throw new Error('MA2 回读与歌曲时间码起点不一致');
  const map = new LightingTempoMap(expected.tempos);
  const boundIds = new Set([...binding.baselineTracks.map((track) => track.id), ...(binding.pendingTracks ?? []).map((track) => track.trackId)]);
  const nativeNames = new Map(binding.baselineTracks.flatMap((track) => track.clips.flatMap((clip) => clip.events.flatMap((event) => event.kind === 'ma2' || event.kind === 'ma2-fader' ? [[event.id, event.label] as const] : []))));
  const updated = new Map<string, LightingTrack>();
  for (const remote of confirmed.document.tracks) {
    if (expected.tracks.some((track) => track.id === remote.id && !boundIds.has(track.id))) throw new Error('回读轨道与未绑定的节目轨道冲突');
    const current = expected.tracks.find((track) => track.id === remote.id);
    if (!current) { updated.set(remote.id, structuredClone(remote)); continue; }
    const events = new Map(remote.clips.flatMap((clip) => {
      if (clip.timeLock !== 'time') throw new Error('MA2 回读必须使用绝对时间');
      return clip.events.map((event) => [event.id, { event, ms: clip.start + event.at }] as const);
    }));
    if (events.size !== remote.clips.reduce((count, clip) => count + clip.events.length, 0)) throw new Error('MA2 回读事件 ID 重复');
    const used = new Set<string>();
    const clips = current.clips.map((clip) => {
      const retained = clip.events.flatMap((event) => {
        const next = events.get(event.id);
        if (!next) return [];
        if (used.has(event.id)) throw new Error('节目内绑定事件 ID 重复');
        used.add(event.id);
        const annotated = (event.kind === 'ma2' || event.kind === 'ma2-fader') && event.label !== nativeNames.get(event.id);
        const keepLabel = event.kind === next.event.kind && (next.event.kind === 'ma2-fader' ? annotated : next.event.kind === 'ma2' && (next.event.action !== 'goto' || annotated));
        return [{ ...next, event: keepLabel && 'label' in event && 'label' in next.event ? { ...next.event, label: event.label } : next.event }];
      });
      const positions = retained.map((entry) => clip.timeLock === 'time' ? entry.ms : map.msToBeat(entry.ms));
      // Moving before the old clip start extends the clip without moving its other points.
      const start = positions.reduce((minimum, value) => Math.min(minimum, value), clip.start);
      const nextEvents = retained.map((entry, index) => ({ ...entry.event, at: positions[index]! - start }));
      const duration = nextEvents.reduce((end, event) => Math.max(end, event.at + 0.001), clip.start + clip.duration - start);
      return { ...clip, start, duration, events: nextEvents };
    });
    for (const clip of remote.clips) {
      const additions = clip.events.filter((event) => !used.has(event.id));
      if (additions.length) clips.push({ ...structuredClone(clip), id: crypto.randomUUID(), events: structuredClone(additions) });
    }
    const baselineName = binding.baselineTracks.find((track) => track.id === remote.id)?.name;
    updated.set(remote.id, { ...current, name: current.name !== baselineName ? current.name : remote.name, muted: remote.muted, clips });
  }
  const ordered = confirmed.document.tracks.map((track) => updated.get(track.id)!);
  let index = 0;
  const tracks = expected.tracks.flatMap((track) => {
    if (!boundIds.has(track.id)) return [track];
    const next = ordered[index++]; return next ? [next] : [];
  });
  tracks.push(...ordered.slice(index));
  const lighting = lightingDocumentSchema.parse({ ...expected, tracks, ma2Bindings: expected.ma2Bindings?.map((entry) => entry.id === bindingId ? {
    ...entry, name: confirmed.name, readAt: confirmed.readAt, sourceXml: confirmed.sourceXml, pendingTracks: undefined,
    nativeEvents: structuredClone(confirmed.unconverted), playback: confirmed.unconverted.length ? 'native-timecode' as const : 'editable' as const,
    baselineTracks: structuredClone(confirmed.document.tracks), mappings: structuredClone(confirmed.mappings), trackMappings: structuredClone(confirmed.trackMappings), cueCatalog: [...new Map([...(entry.cueCatalog ?? []), ...(confirmed.cueCatalog ?? [])].map((sequence) => [sequence.sequence, structuredClone(sequence)])).values()]
  } : entry) });
  const confirmedBinding = lighting.ma2Bindings!.find(entry => entry.id === bindingId)!;
  return { id: crypto.randomUUID(), label: '应用 MA2 同步回读', historyRebaseKey: `ma2:${itemId}:${bindingId}`, rebaseHistory: project => ({
    ...project, rundown: project.rundown.map(item => item.id !== itemId || !item.lighting ? item : {
      ...item, lighting: { ...item.lighting, ma2Bindings: item.lighting.ma2Bindings?.map(entry => entry.id === bindingId ? confirmedBinding : entry) }
    })
  }), execute(project) {
    const next = structuredClone(project);
    const item = next.rundown.find((entry) => entry.id === itemId);
    if (!item?.lighting) throw new Error('同步期间节目已移除，未应用回读');
    const latest = lightingDocumentSchema.parse(item.lighting);
    if (JSON.stringify(latest) === JSON.stringify(expected)) item.lighting = structuredClone(lighting);
    else {
      if (!preserveLaterEdits || JSON.stringify(latest.ma2Bindings) !== JSON.stringify(expected.ma2Bindings)) throw new Error('同步期间节目灯光绑定已修改，未覆盖本地内容，请重新读取比较');
      // A confirmed local-only write acknowledges the captured revision. Later edits
      // remain pending against that baseline, including deletion and undo during I/O.
      const submitted = new Map(expected.tracks.map(track => [track.id, track]));
      const acknowledged = new Map(lighting.tracks.map(track => [track.id, track]));
      item.lighting = lightingDocumentSchema.parse({ ...latest,
        tracks: latest.tracks.flatMap(track => {
          if (JSON.stringify(track) !== JSON.stringify(submitted.get(track.id))) return [track];
          const confirmedTrack = acknowledged.get(track.id);
          return confirmedTrack ? [confirmedTrack] : [];
        }),
        ma2Bindings: latest.ma2Bindings?.map(entry => entry.id === bindingId ? confirmedBinding : entry)
      });
    }
    next.schemaVersion = 2; next.updatedAt = new Date().toISOString();
    return parseLinkProject(next);
  }, undo: (before) => parseLinkProject(before) };
}
