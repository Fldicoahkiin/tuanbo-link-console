import { CuePoolGrid } from './CuePoolGrid';
import { useMemo, useState } from 'react';
import { libraryReferenceIssue, projectLightingLibrary, assertMusicCueConflicts, lightingPositions, moveMusicCues, musicBeatToMs, musicMsToBeat, type CuePositionChange } from '@tb/core/link';
import { lightingDocumentSchema, type LightingDocument, type LightingEvent, type LightingTrack } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { ma2SequenceLibrary } from '../view-models/ma2-sequence-library';
import { useDocumentStore } from '../stores/document-store';

type Source = { id: string; name: string; events: LightingEvent[] };
export function LightingMusicBatch({ lighting, playheadMs, durationMs, markerId, range, onPreview }: { lighting: LightingTimelineProps; playheadMs: number; durationMs: number; markerId: string | null; range: { start: number; end: number } | null; onPreview: (next: LightingDocument, changes: CuePositionChange[], label: string) => void }): JSX.Element {
  const document = lighting.document; const project = useDocumentStore(state => state.project);
  const [operation, setOperation] = useState('place'); const [sourceMode, setSourceMode] = useState('selected');
  const [routes, setRoutes] = useState<Record<string,string>>({});
  const [sourceIds, setSourceIds] = useState<string[]>([]); const [query, setQuery] = useState('');
  const [start, setStart] = useState(range?.start ?? playheadMs); const [interval, setInterval] = useState(1);
  const [count, setCount] = useState(1); const [end, setEnd] = useState(range?.end ?? durationMs); const [untilEnd, setUntilEnd] = useState(false);
  const [cycle, setCycle] = useState(false); const [targetMarker, setTargetMarker] = useState(markerId ?? '');
  const [markerEdge, setMarkerEdge] = useState('start');
  const [offset, setOffset] = useState(0); const [unit, setUnit] = useState('ms');
  const [trackId, setTrackId] = useState(document.tracks.find(track => track.clips.some(clip => clip.id === lighting.selectedClipId))?.id ?? (document.tracks.length === 1 ? document.tracks[0]!.id : ''));
  const [error, setError] = useState('');
  const selectedIds = useMemo(() => lighting.selectedEventIds ?? (lighting.selectedEventId ? [lighting.selectedEventId] : []), [lighting.selectedEventIds, lighting.selectedEventId]);
  const sources = useMemo((): Source[] => {
    if (sourceMode === 'selected') return document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => selectedIds.includes(event.id) && event.kind === 'ma2').map(event => ({ id: event.id, name: event.kind === 'ma2' ? event.label : track.name, events: [{ ...event, at: 0 }] }))));
    if (sourceMode === 'library') return document.templates.flatMap(template => {
      const stamp = template.track.cueStamp; if (stamp?.mode !== 'fixed') return [];
      const members = template.members ?? [{ ...stamp, name: template.name, delayMs: 0 }];
      return [{ id: template.id, name: template.name, events: members.map(member => ({ id: crypto.randomUUID(), kind: 'ma2' as const, action: 'goto' as const, label: member.name, at: member.delayMs, executor: member.executor, sequence: member.sequence, cue: member.cue, librarySource: { id: template.id, revision: template.libraryRevision ?? 1 } })) }];
    });
    return ma2SequenceLibrary(project, document).flatMap(sequence => sequence.cues.map(cue => ({ id: `${sequence.sequence}:${cue.number}`, name: `${sequence.name ?? sequence.sequence} · ${cue.number} ${cue.name ?? ''}`, events: [{ id: crypto.randomUUID(), kind: 'ma2' as const, action: 'goto' as const, label: cue.name ?? `Cue ${cue.number}`, executor: '', sequence: sequence.sequence, cue: cue.number, at: 0 }] })));
  }, [document, project, sourceMode, selectedIds]);
  const visibleSources = sources.filter(source => source.name.toLowerCase().includes(query.toLowerCase()));
  const chosen = sourceMode === 'selected' ? sources : sourceIds.flatMap(id => sources.filter(source => source.id === id));
  const preview = (): void => {
    try {
      if (operation !== 'place') {
        const positions = lightingPositions(document).filter(value => selectedIds.includes(value.id));
        if (!positions.length) throw new Error('请先选择需要移动的 Cue');
        const first = Math.min(...positions.map(value => value.fromMs));
        const marker = document.markers.find(value => value.id === targetMarker);
        const delta = operation === 'marker' ? (markerEdge === 'end' ? marker?.endMs ?? NaN : marker?.startMs ?? NaN) - first : unit === 'beats' ? musicBeatToMs(document, musicMsToBeat(document, first) + offset) - first : offset;
        const changes = positions.map(value => ({ ...value, toMs: value.fromMs + delta }));
        onPreview(moveMusicCues(document, changes, durationMs), changes, operation === 'marker' ? '选中 Cue 对齐音乐标记' : '整组移动 Cue'); return;
      }
      if (!chosen.length) throw new Error('请选择需要放置的 Cue');
      if (sourceMode === 'library' && project) for (const source of chosen) { const entry=projectLightingLibrary(project).entries.find(value=>value.id===source.id); if(!entry)throw new Error('分类素材已失效');const issue=libraryReferenceIssue(project,entry);if(issue)throw new Error(issue); }
      if (sourceMode === 'console' && project?.ma2MaterialLibrary?.library?.sourceUnverified) throw new Error('当前控台目录来源待核对');

      if (!Number.isFinite(interval) || interval <= 0 || !Number.isInteger(count) || count < 1) throw new Error('拍数间隔与数量必须有效');
      if (start < 0 || start >= durationMs || untilEnd && (end <= start || end > durationMs)) throw new Error('请选择歌曲内的有效范围');
      const times: number[] = []; const beat = count === 1 && !untilEnd ? 0 : musicMsToBeat(document, start);
      const amount = untilEnd ? 50001 : count;
      for (let i = 0; i < amount; i++) { const ms = i === 0 ? start : musicBeatToMs(document, beat + i * interval); if (untilEnd && ms >= end) break; if (times.length === 50000) throw new Error('本次批量操作超过 50000 项，请分段编排'); times.push(ms); }
      if (chosen.length > 1 && !cycle && times.length > chosen.length) throw new Error('所选 Cue 数量不足；请减少数量或明确开启循环使用');
      const target = document.tracks.find(track => track.id === trackId); if (trackId !== 'new' && (!target || target.locked || target.kind !== 'ma2')) throw new Error('请选择未锁定的灯光轨道');
      const track: LightingTrack = target ?? { id: crypto.randomUUID(), name: '灯光', kind: 'ma2', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] };
      const events: LightingEvent[] = []; const changes: CuePositionChange[] = [];
      times.forEach((ms, index) => {
        const source = chosen[index % chosen.length]!; const groupId = source.events.length > 1 ? crypto.randomUUID() : undefined;
        source.events.forEach(event => {
          const id = crypto.randomUUID(); const at = ms + event.at;
          if (at < 0 || at >= durationMs) throw new Error('Cue 超出歌曲范围，未添加');
          const targets = event.kind === 'ma2' ? [...new Set(document.ma2Bindings?.flatMap(binding=>binding.mappings.filter(mapping=>mapping.sequence===event.sequence).map(mapping=>mapping.executor)) ?? [])] : [];
          if(sourceMode === 'console' && event.kind==='ma2' && targets.length>1 && routes[String(event.sequence)] === undefined) throw new Error(`序列 ${event.sequence} 有多个执行器，请明确选择目标`);
          const added = { ...event, ...(sourceMode==='console' && event.kind==='ma2' ? {executor:routes[String(event.sequence)] ?? (targets.length===1 ? targets[0]! : '')} : {}), id, at, ...(groupId ? { effectGroupId: groupId } : {}) }; delete added.beatAnchor;
          events.push(added); changes.push({ id, name: source.name, fromMs: at, toMs: at });
        });
      });
      const updated = { ...track, clips: [...track.clips, { id: crypto.randomUUID(), name: '按节拍编排', start: 0, duration: durationMs, timeLock: 'time' as const, muted: false, events }] };
      const next = lightingDocumentSchema.parse({ ...document, version: 2, tracks: target ? document.tracks.map(value => value.id === track.id ? updated : value) : [...document.tracks, updated] });
      assertMusicCueConflicts(next); onPreview(next, changes, '批量添加灯光 Cue'); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="music-batch"><div className="music-fields"><label>操作<select value={operation} onChange={event => setOperation(event.target.value)}><option value="place">添加 / 按拍数排列</option><option value="marker">选中 Cue 对齐标记</option><option value="move">整组提前 / 延后</option></select></label>
    <label>音乐标记<select aria-label="音乐标记" value={targetMarker} onChange={event => { setTargetMarker(event.target.value); setMarkerEdge('start'); const marker = document.markers.find(value => value.id === event.target.value); if (marker) { setStart(marker.startMs); setCount(1); setUntilEnd(false); if (marker.endMs !== null) setEnd(marker.endMs); } }}><option value="">选择标记</option>{document.markers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
    {document.markers.some(marker => marker.id === targetMarker && marker.endMs !== null) ? <label>范围用法<select value={markerEdge} onChange={event => { const edge=event.target.value;setMarkerEdge(edge);const marker=document.markers.find(value=>value.id===targetMarker);if(marker?.endMs!==null && marker){setStart(edge==='end' ? marker.endMs : marker.startMs);setEnd(marker.endMs);setUntilEnd(edge==='range');setCount(1);} }}><option value="start">使用起点</option><option value="end">使用终点</option>{operation==='place' ? <option value="range">范围内排列</option> : null}</select></label> : null}
    {operation === 'move' ? <><label>偏移<input type="number" step="any" value={offset} onChange={event => setOffset(event.target.valueAsNumber)} /></label><select aria-label="偏移单位" value={unit} onChange={event => setUnit(event.target.value)}><option value="ms">毫秒</option><option value="beats">拍</option></select></> : null}
    {operation === 'place' ? <><label>来源<select aria-label="来源" value={sourceMode} onChange={event => { setSourceMode(event.target.value); setSourceIds([]); }}><option value="selected">使用选中的 Cue</option><option value="console">从控台 Cue 列表选择</option><option value="library">从我的分类选择</option></select></label><label>目标轨道<select aria-label="目标轨道" value={trackId} onChange={event => setTrackId(event.target.value)}><option value="">选择轨道</option>{document.tracks.filter(track => track.kind === 'ma2' && !track.locked).map(track => <option key={track.id} value={track.id}>{track.name}</option>)}<option value="new">新建灯光轨道</option></select></label><label>起点（秒）<input type="number" min="0" step="0.001" value={start / 1000} onChange={event => setStart(event.target.valueAsNumber * 1000)} /></label><button onClick={() => { setStart(playheadMs); setCount(1); setUntilEnd(false); }}>使用播放头</button><label>间隔（拍）<input type="number" min="0.001" step="any" value={interval} onChange={event => setInterval(event.target.valueAsNumber)} /></label><label><input type="checkbox" checked={untilEnd} onChange={event => setUntilEnd(event.target.checked)} />按结束位置排列</label>{untilEnd ? <label>结束（秒）<input type="number" min="0" step="0.001" value={end / 1000} onChange={event => setEnd(event.target.valueAsNumber * 1000)} /></label> : <label>数量<input type="number" min="1" value={count} onChange={event => setCount(event.target.valueAsNumber)} /></label>}<label><input type="checkbox" checked={cycle} onChange={event => setCycle(event.target.checked)} />循环使用选中的 Cue</label></> : null}</div>
    {operation === 'place' && sourceMode !== 'selected' ? <><input aria-label="搜索编排来源" placeholder="搜索 Cue" value={query} onChange={event => setQuery(event.target.value)} /><div className="music-source-list"><CuePoolGrid cellWidth={260} keys={visibleSources.map(source => source.id)} label="编排来源列表" render={index => { const source = visibleSources[index]!; return <label><input type="checkbox" aria-label={source.name} checked={sourceIds.includes(source.id)} onChange={event => setSourceIds(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))} />{sourceIds.includes(source.id) ? `${sourceIds.indexOf(source.id) + 1}. ` : ''}{source.name}</label>; }} /></div><small>已选 {sourceIds.length} 项，按勾选顺序编排</small></> : null}
    {sourceMode === 'console' ? [...new Set(chosen.flatMap(source=>source.events.flatMap(event=>event.kind==='ma2' ? [event.sequence] : [])))].map(sequence=>{const targets=[...new Set(document.ma2Bindings?.flatMap(binding=>binding.mappings.filter(mapping=>mapping.sequence===sequence).map(mapping=>mapping.executor)) ?? [])];return targets.length>1 ? <label key={sequence}>序列 {sequence} 播放目标<select aria-label={`序列 ${sequence} 播放目标`} value={routes[String(sequence)] ?? '__choose'} onChange={event=>setRoutes({...routes,[String(sequence)]:event.target.value})}><option value="__choose" disabled>选择目标</option><option value="">序列池</option>{targets.map(target=><option key={target}>{target}</option>)}</select></label> : null;}) : null}
    {error ? <p role="alert">{error}</p> : null}<button onClick={preview}>生成修改预览</button>
  </div>;
}
