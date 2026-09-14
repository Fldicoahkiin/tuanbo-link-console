import { createPortal } from 'react-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createFixedLightingCueStamp, duplicateLightingClip, nextLightingCue, lightingCurveValue, LightingTempoMap, lightingClipSpan, quantizeLightingClip, splitLightingClip, trimLightingClip, mergeLightingClips } from '@tb/core/link';
import type { LightingClip, LightingDocument, LightingEvent, LightingTrack } from '@tb/schema';
import { Copy, Flag, Plus, Scissors, Trash2, X } from 'lucide-react';
import { PropertyNumberInput } from './PropertyNumberInput';
import { LightingEventFields } from './LightingEventFields';
import { LightingFileActions } from './LightingFileActions';
import { LightingArrangementSettings } from './LightingArrangementSettings';
import { useIntegrationStore } from '../stores/integration-store';
import type { LightingTimelineProps } from './LightingTimeline';

type Props = LightingTimelineProps & { inspectorHost: HTMLDivElement | null; initialTab?: 'settings'; settingsPageSection?: SettingsSection; trackId: string; playheadMs: number; onClose?: () => void; notify: (message: string, tone?: 'info' | 'error') => void };
const eventNames: Record<LightingEvent['kind'], string> = { 'ma2-fader': 'MA2 主推杆', ma2: '灯光切换', note: '音符', cc: '控制值', point: '推杆变化', program: '程序切换', raw: 'MIDI 消息' };
const clock = (ms: number): string => `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${(ms % 60000 / 1000).toFixed(3).padStart(6, '0')}`;
type SettingsSection = 'track' | 'arrangement' | 'files' | 'output';
const settingsSections = [['track', '轨道'], ['arrangement', '节拍与循环'], ['files', '导入与导出'], ['output', '输出配置']] as const;

export function LightingEditor(props: Props): JSX.Element {
  const track = props.document.tracks.find((entry) => entry.id === props.trackId);
  const clip = track?.clips.find((entry) => entry.id === props.selectedClipId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [grid, setGrid] = useState(0.25);
  const [eventPage, setEventPage] = useState(0);
  const [tab, setTab] = useState<'edit' | 'clip' | 'settings'>(props.initialTab ?? 'edit');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('track');
  const [view, setView] = useState<'canvas' | 'list'>('canvas');
  const map = useMemo(() => new LightingTempoMap(props.document.tempos), [props.document.tempos]);
  const ordered = useMemo(() => [...(clip?.events ?? [])].sort((a, b) => a.at - b.at), [clip?.events]);
  const changeTrack = (next: LightingTrack, label: string): void => props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === next.id ? next : entry) }, label);
  const changeClip = (next: LightingClip, label: string): void => { if (track && !track.locked) changeTrack({ ...track, clips: track.clips.map((entry) => entry.id === next.id ? next : entry) }, label); };
  const guard = (action: () => void): void => { try { action(); } catch (error) { props.notify(error instanceof Error ? error.message : String(error), 'error'); } };
  const addEvent = (): void => {
    if (!clip || !track || track.locked) return;
    if (track.kind === 'ma2' && track.cueStamp?.mode === 'marker') {
      props.onChange({ ...props.document, markers: [...props.document.markers, { id: crypto.randomUUID(), name: `标记 ${props.document.markers.length + 1}`, startMs: props.playheadMs, endMs: null }] }, '时间线打标记');
      return;
    }
    const at = (clip.timeLock === 'time' ? props.playheadMs : map.msToBeat(props.playheadMs)) - clip.start;
    if (at < 0 || at >= clip.duration) { props.notify('请将播放头移到当前灯光片段内，再打点', 'error'); return; }
    let event: LightingEvent;
    try {
      event = track.kind === 'ma2'
        ? { id: crypto.randomUUID(), kind: 'ma2', at, ...nextLightingCue(props.document, track, props.playheadMs), action: 'goto' }
        : makeEvent(track, at, Math.min(clip.duration - at, clip.timeLock === 'time' ? 200 : 0.25), clip.events.length);
    } catch (error) { props.notify(error instanceof Error ? error.message : String(error), 'error'); return; }
    changeClip({ ...clip, events: [...clip.events, event] }, '灯光打点');
    setSelected(new Set([event.id])); setEventPage(Math.floor(clip.events.filter((entry) => entry.at <= at).length / 200));
  };
  useEffect(() => { setSelected(new Set()); setEventPage(0); }, [props.selectedClipId]);
  useEffect(() => { setEventPage((page) => Math.min(page, Math.max(0, Math.ceil((clip?.events.length ?? 0) / 200) - 1))); }, [clip?.events.length]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || tab !== 'edit' || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (event.code === 'KeyM' && !event.repeat && !event.ctrlKey && !event.altKey && !event.metaKey) { event.preventDefault(); addEvent(); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  if (!track) return <div className="lighting-editor lighting-empty"><p>轨道已删除</p><button onClick={props.onClose}>返回画面编辑</button></div>;
  const listVisible = track.kind === 'ma2' || view === 'list';
  const unit = clip?.timeLock === 'beat' ? '拍' : '秒';
  const scale = clip?.timeLock === 'beat' ? 1 : 1000;
  const removeSelected = (): void => { if (clip) changeClip({ ...clip, events: clip.events.filter((event) => !selected.has(event.id)) }, '删除灯光事件'); setSelected(new Set()); };
  return <section className="lighting-editor" aria-label="灯光片段编辑器">
    {props.inspectorHost ? createPortal(<div className="lighting-editor lighting-inspector"><h3>{track.name}</h3><p className="lighting-muted">{clip?.name ?? '尚无片段'}{clip ? ` · ${clip.events.length} 个灯光事件` : ''}</p>
      {clip && selected.size === 1 ? clip.events.filter((entry) => selected.has(entry.id)).map((event) => <div key={event.id} className="lighting-inspector-fields"><h3>{eventNames[event.kind]}</h3><label>片段内位置（{unit}）<input aria-label="选中灯光位置" type="number" min={0} step="0.001" value={event.at / scale} disabled={track.locked} onChange={(e) => changeClip({ ...clip, events: clip.events.map((entry) => entry.id === event.id ? { ...entry, at: Number(e.target.value) * scale } : entry) }, '修改事件位置')} /></label><LightingEventFields event={event} timeLock={clip.timeLock} disabled={track.locked} onChange={(changed) => changeClip({ ...clip, events: clip.events.map((entry) => entry.id === event.id ? changed : entry) }, '修改灯光参数')} /><button disabled={track.locked} onClick={removeSelected}><Trash2 />删除这个灯光点</button></div>) : <div className="lighting-empty"><strong>{selected.size ? `已选中 ${selected.size} 个事件` : '选择一个灯光点'}</strong><p>{selected.size ? '可在编排列表中批量删除。' : '在这里修改时间、名称和控制参数。'}</p></div>}
    </div>, props.inspectorHost) : null}
    {!props.settingsPageSection ? <header><nav aria-label="灯光编辑导航">
      {([['edit', '灯光编排'], ['clip', '片段操作']] as const).map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
      {settingsSections.map(([id, label]) => <button key={id} aria-pressed={tab === 'settings' && settingsSection === id} onClick={() => { setTab('settings'); setSettingsSection(id); }}>{label}</button>)}
    </nav>{props.onClose ? <button aria-label="关闭灯光编辑器" title="返回画面编辑" onClick={props.onClose}><X /></button> : null}</header> : null}
    {track.locked ? <div className="lighting-notice">轨道已锁定<button onClick={() => changeTrack({ ...track, locked: false }, '解锁灯光轨道')}>解锁编辑</button></div> : null}
    {tab === 'settings' ? <LightingSettings section={props.settingsPageSection ?? settingsSection} document={props.document} track={track} onChange={props.onChange} changeTrack={changeTrack} notify={props.notify} /> : tab === 'clip' ? <div className="lighting-panel-scroll">
      {clip ? <>
        <h3>当前片段</h3><div className="lighting-settings lighting-clip-settings">
          <label>片段名称<input key={clip.id + clip.name} aria-label="灯光片段名称" defaultValue={clip.name} onBlur={(event) => changeClip({ ...clip, name: event.target.value.trim() || clip.name }, '重命名灯光片段')} disabled={track.locked} /></label>
          <label>起点（{unit}）<input aria-label="灯光片段起点" type="number" min={0} step="0.001" value={clip.start / scale} onChange={(event) => changeClip({ ...clip, start: Number(event.target.value) * scale }, '移动灯光片段')} disabled={track.locked} /></label>
          <label>长度（{unit}）<input aria-label="灯光片段长度" type="number" min={0.001} step="0.001" value={clip.duration / scale} onChange={(event) => guard(() => changeClip(trimLightingClip(clip, Number(event.target.value) * scale), '修剪灯光片段'))} disabled={track.locked} /></label>
          <label>随节拍变化<select aria-label="时间锁定方式" value={clip.timeLock} disabled={track.locked} onChange={(event) => {
            const mode = event.target.value as 'time' | 'beat'; if (mode === clip.timeLock) return;
            const span = lightingClipSpan(clip, map); const start = mode === 'time' ? span.startMs : map.msToBeat(span.startMs);
            const convert = (at: number): number => mode === 'beat' ? map.msToBeat(clip.start + at) - start : map.beatToMs(clip.start + at) - start;
            changeClip({ ...clip, start, duration: mode === 'time' ? span.endMs - span.startMs : map.msToBeat(span.endMs) - start, timeLock: mode, events: clip.events.map((entry) => entry.kind === 'note' ? { ...entry, at: convert(entry.at), duration: convert(entry.at + entry.duration) - convert(entry.at) } : { ...entry, at: convert(entry.at) }) }, '转换灯光时间锁定');
          }}><option value="time">固定时间</option><option value="beat">跟随节拍</option></select></label>
        </div>
        <div className="lighting-tools"><button disabled={track.locked} onClick={() => { const copy = duplicateLightingClip(clip); changeTrack({ ...track, clips: [...track.clips, copy] }, '复制灯光片段'); props.onSelect(track.id, copy.id); }}><Copy />复制片段</button>
          <button disabled={track.locked} onClick={() => guard(() => { const at = (clip.timeLock === 'time' ? props.playheadMs : map.msToBeat(props.playheadMs)) - clip.start; const parts = splitLightingClip(clip, at); changeTrack({ ...track, clips: track.clips.flatMap((entry) => entry.id === clip.id ? parts : [entry]) }, '拆分灯光片段'); props.onSelect(track.id, parts[0].id); })}><Scissors />在播放头拆分</button>
          <button disabled={track.locked || track.clips.length < 2} onClick={() => guard(() => { const merged = mergeLightingClips(track.clips, map); changeTrack({ ...track, clips: [merged] }, '合并轨道片段'); props.onSelect(track.id, merged.id); })}>合并本轨全部片段</button>
          <button disabled={track.locked} onClick={() => { changeTrack({ ...track, clips: track.clips.filter((entry) => entry.id !== clip.id) }, '删除灯光片段'); props.onSelect(track.id, track.clips.find((entry) => entry.id !== clip.id)?.id ?? null); }}><Trash2 />删除片段</button></div>
        <h3>对齐节拍</h3><div className="lighting-tools"><select aria-label="灯光量化网格" value={grid} onChange={(event) => setGrid(Number(event.target.value))}><option value={1}>四分音符</option><option value={0.5}>八分音符</option><option value={0.25}>十六分音符</option><option value={1 / 3}>八分三连音</option><option value={0.125}>三十二分音符</option></select>
        <button disabled={track.locked} onClick={() => guard(() => changeClip(quantizeLightingClip(clip, map, grid), '量化灯光'))}>对齐整个片段</button></div>
      </> : <p className="lighting-muted">当前轨道没有片段，请返回灯光编排创建。</p>}
    </div> : <>
      <div className="lighting-workbar"><span>{clip?.name ?? '尚无片段'}</span><time>{clock(props.playheadMs)}</time><button onClick={() => props.onChange({ ...props.document, markers: [...props.document.markers, { id: crypto.randomUUID(), name: `标记 ${props.document.markers.length + 1}`, startMs: props.playheadMs, endMs: null }] }, '添加标记')}><Flag />添加标记</button></div>
      {clip ? <>
        {track.kind === 'ma2' ? <div className="lighting-tools"><button className="lighting-primary" disabled={track.locked} onClick={addEvent}><Plus />在当前位置打点 <kbd>M</kbd></button></div> : <div className="lighting-tools"><button className="lighting-primary" disabled={track.locked} onClick={addEvent}><Plus />在当前位置添加 <kbd>M</kbd></button><nav aria-label="灯光显示方式"><button aria-pressed={view === 'canvas'} onClick={() => setView('canvas')}>{track.kind === 'midi' ? '音符网格' : '推杆曲线'}</button><button aria-pressed={view === 'list'} onClick={() => setView('list')}>事件列表</button></nav></div>}
        <div className="lighting-list-heading"><span>{clip.events.length} 个{track.kind === 'ma2' ? '灯光点' : '事件'}{selected.size ? ` · 已选 ${selected.size}` : ''}</span><button disabled={track.locked || !selected.size} onClick={removeSelected}><Trash2 />删除选中</button></div>
        {listVisible ? <div className="lighting-event-list"><table><thead><tr><th><input type="checkbox" aria-label="选择本页全部事件" checked={ordered.slice(eventPage * 200, (eventPage + 1) * 200).length > 0 && ordered.slice(eventPage * 200, (eventPage + 1) * 200).every((event) => selected.has(event.id))} onChange={(e) => setSelected((old) => { const next = new Set(old); for (const event of ordered.slice(eventPage * 200, (eventPage + 1) * 200)) { if (e.target.checked) next.add(event.id); else next.delete(event.id); } return next; })} /></th><th>片段内位置（{unit}）</th><th>{track.kind === 'ma2' ? '灯光' : '类型'}</th><th>参数</th></tr></thead><tbody>
          {ordered.slice(eventPage * 200, (eventPage + 1) * 200).map((event) => <tr key={event.id} className={selected.has(event.id) ? 'selected' : ''}><td><input type="checkbox" aria-label={`选择事件 ${event.id}`} checked={selected.has(event.id)} onChange={(input) => setSelected((previous) => { const next = new Set(previous); if (input.target.checked) next.add(event.id); else next.delete(event.id); return next; })} /></td><td><input type="number" aria-label="事件位置" value={Number((event.at / scale).toFixed(6))} disabled={track.locked} min={0} step="0.001" onChange={(input) => changeClip({ ...clip, events: clip.events.map((entry) => entry.id === event.id ? { ...event, at: Number(input.target.value) * scale } : entry) }, '修改事件位置')} /></td><td>{event.kind === 'ma2' ? event.action === 'goto' ? `Cue ${event.cue}` : event.action === 'go' ? '下一步' : '关闭执行器' : eventNames[event.kind]}</td><td><button className="lighting-event-summary" aria-label={`编辑灯光点 ${event.id}`} onClick={() => setSelected(new Set([event.id]))}>{event.kind === 'ma2' ? `${event.label} · 执行器 ${event.executor}` : event.kind === 'ma2-fader' ? `Master ${Number((event.level * 100).toFixed(6))}% · 执行器 ${event.executor}` : event.kind === 'note' ? `音符 ${event.note} · 力度 ${event.velocity}` : event.kind === 'point' || event.kind === 'cc' ? `值 ${event.value}` : event.kind === 'program' ? `程序 ${event.program}` : event.label}</button></td></tr>)}
        </tbody></table>{!clip.events.length ? <div className="lighting-empty"><strong>从第一个灯光点开始</strong><p>播放音乐，在需要切换灯光的位置按 M。</p></div> : null}</div> : <><LightingCanvas clip={clip} track={track} selected={selected} onSelect={setSelected} onChange={(next) => changeClip(next, '编辑灯光事件')} /></>}
        {listVisible && clip.events.length > 200 ? <div className="lighting-tools"><button disabled={!eventPage} onClick={() => setEventPage((page) => page - 1)}>上一页</button><span>{eventPage + 1} / {Math.ceil(clip.events.length / 200)}</span><button disabled={(eventPage + 1) * 200 >= clip.events.length} onClick={() => setEventPage((page) => page + 1)}>下一页</button></div> : null}
      </> : <div className="lighting-empty"><strong>为这条轨道创建编排片段</strong><button disabled={track.locked} onClick={() => { const next: LightingClip = { id: crypto.randomUUID(), name: '灯光编排', start: props.playheadMs, duration: 8000, timeLock: 'time', muted: false, events: [] }; changeTrack({ ...track, clips: [...track.clips, next] }, '添加灯光片段'); props.onSelect(track.id, next.id); }}>在当前位置创建片段</button></div>}
    </>}
  </section>;
}

function makeEvent(track: LightingTrack, at: number, duration: number, count: number): LightingEvent {
  const id = crypto.randomUUID();
  if (track.kind === 'ma2') return { id, kind: 'ma2', at, cue: String(count + 1), label: `Cue ${count + 1}`, action: 'goto', sequence: 1, executor: '1.1' };
  if (track.kind === 'automation') return { id, kind: 'point', at, value: 127, shape: 'linear' };
  return { id, kind: 'note', at, duration, note: 60, velocity: 127 };
}

function LightingCanvas(props: { clip: LightingClip; track: LightingTrack; selected: Set<string>; onSelect: (ids: Set<string>) => void; onChange: (clip: LightingClip) => void }): JSX.Element {
  const { clip, track } = props;
  const [preview, setPreview] = useState<LightingClip | null>(null);
  const drag = useRef<{ x: number; y: number; width: number; height: number; ids: Set<string>; resize: boolean; original: LightingClip; next: LightingClip | null } | null>(null);
  const displayed = preview ?? clip;
  const points = displayed.events.filter((event) => event.kind === 'point').sort((a, b) => a.at - b.at);
  const curvePath = points.flatMap((point, index) => {
    const next = points[index + 1];
    const start = `${point.at / clip.duration * 1000},${256 - point.value * 2}`;
    if (!next) return [start];
    if (point.shape === 'hold') return [start, `${next.at / clip.duration * 1000},${256 - point.value * 2}`];
    if (point.shape === 'linear') return [start];
    return Array.from({ length: 20 }, (_, step) => { const t = step / 20; const value = lightingCurveValue(point, next, t); return `${(point.at + (next.at - point.at) * t) / clip.duration * 1000},${256 - value * 2}`; });
  }).join(' ');
  return <svg className="lighting-canvas" viewBox="0 0 1000 256" preserveAspectRatio="none" role="img" aria-label="灯光音符与曲线网格" onPointerMove={(input) => {
    const current = drag.current; if (!current) return;
    const selectedEvents = current.original.events.filter((event) => current.ids.has(event.id));
    const requested = (input.clientX - current.x) / current.width * clip.duration;
    const lower = Math.max(...selectedEvents.map((event) => current.resize && event.kind === 'note' ? -event.duration + 0.001 : -event.at));
    const upper = Math.min(...selectedEvents.map((event) => clip.duration - event.at - (event.kind === 'note' ? event.duration : 0.001)));
    const delta = Math.max(lower, Math.min(upper, requested));
    const pitch = Math.round((current.y - input.clientY) / current.height * 127);
    current.next = { ...current.original, events: current.original.events.map((event) => {
      if (!current.ids.has(event.id)) return event;
      if (current.resize && event.kind === 'note') return { ...event, duration: event.duration + delta };
      if (event.kind === 'note') return { ...event, at: event.at + delta, note: Math.max(0, Math.min(127, event.note + pitch)) };
      if (event.kind === 'point') return { ...event, at: event.at + delta, value: Math.max(0, Math.min(127, event.value + pitch)) };
      return { ...event, at: event.at + delta };
    }) };
    setPreview(current.next);
  }} onPointerUp={() => { const next = drag.current?.next; drag.current = null; setPreview(null); if (next) props.onChange(next); }} onPointerCancel={() => { drag.current = null; setPreview(null); }} onDoubleClick={(event) => {
    if (track.locked) return; const bounds = event.currentTarget.getBoundingClientRect();
    const at = Math.max(0, Math.min(clip.duration - 0.001, (event.clientX - bounds.left) / bounds.width * clip.duration));
    const value = Math.max(0, Math.min(127, Math.round(127 - (event.clientY - bounds.top) / bounds.height * 127)));
    const added = makeEvent(track, at, Math.min(clip.duration / 32, clip.duration - at), clip.events.length);
    if (added.kind === 'note') added.note = value; if (added.kind === 'point') added.value = value;
    props.onChange({ ...clip, events: [...clip.events, added] }); props.onSelect(new Set([added.id]));
  }}>
    {Array.from({ length: 17 }, (_, i) => <line key={`v${i}`} x1={i * 62.5} x2={i * 62.5} y1={0} y2={256} className="grid" />)}
    {Array.from({ length: 17 }, (_, i) => <line key={`h${i}`} y1={i * 16} y2={i * 16} x1={0} x2={1000} className="grid" />)}
    {points.length > 1 ? <polyline points={curvePath} fill="none" stroke={track.color} strokeWidth={2} pointerEvents="none" /> : null}
    {displayed.events.map((event) => <rect key={event.id} x={event.at / clip.duration * 1000} y={event.kind === 'note' ? (127 - event.note) * 2 : event.kind === 'point' ? 252 - event.value * 2 : 90}
      width={event.kind === 'note' ? Math.max(4, event.duration / clip.duration * 1000) : 8} height={event.kind === 'note' ? 4 : 12} fill={props.selected.has(event.id) ? '#fff' : track.color}
      onPointerDown={(input) => {
        input.stopPropagation(); if (track.locked || input.button !== 0) return;
        const bounds = input.currentTarget.ownerSVGElement?.getBoundingClientRect(); if (!bounds) return;
        const ids = props.selected.has(event.id) || input.shiftKey ? new Set([...props.selected, event.id]) : new Set([event.id]); props.onSelect(ids);
        const rect = input.currentTarget.getBoundingClientRect();
        const resize = event.kind === 'note' && input.clientX >= rect.right - Math.min(6, rect.width / 4);
        drag.current = { x: input.clientX, y: input.clientY, width: bounds.width, height: bounds.height, ids, resize, original: clip, next: null };
        input.currentTarget.setPointerCapture(input.pointerId);
      }} onDoubleClick={(input) => input.stopPropagation()}><title>{event.kind === 'ma2' ? event.label : event.kind === 'note' ? `${track.noteNames[String(event.note)] ?? event.note} · 拖动移动，右边缘调整长度` : String(event.at)}</title></rect>)}
  </svg>;
}

function LightingSettings(props: { section: SettingsSection; document: LightingDocument; track: LightingTrack; onChange: LightingTimelineProps['onChange']; changeTrack: (track: LightingTrack, label: string) => void; notify: Props['notify'] }): JSX.Element {
  const { document, track, section } = props;
  const ports = useIntegrationStore((state) => state.profile?.midiPortProfiles);
  const field = (key: 'name' | 'group', label: string): JSX.Element => <label>{label}<input key={`${track.id}:${key}`} defaultValue={track[key]} onBlur={(event) => props.changeTrack({ ...track, [key]: event.target.value }, '配置灯光轨道')} disabled={track.locked} /></label>;
  return <div className="lighting-settings-layout"><div className="lighting-settings-content">
    {section === 'track' ? <><div className="lighting-settings">{field('name', '轨道名称')}{field('group', '分组')}
      {track.kind === 'ma2' ? <CueStampSettings document={document} track={track} changeTrack={props.changeTrack} notify={props.notify} /> : null}
      <label>颜色<input type="color" value={track.color} disabled={track.locked} onChange={(event) => props.changeTrack({ ...track, color: event.target.value }, '修改轨道颜色')} /></label>
    </div><div className="lighting-tools">
      {([-1, 1] as const).map((direction) => <button key={direction} disabled={track.locked || document.tracks.indexOf(track) + direction < 0 || document.tracks.indexOf(track) + direction >= document.tracks.length} onClick={() => { const tracks = [...document.tracks]; const from = tracks.indexOf(track); tracks.splice(from, 1); tracks.splice(from + direction, 0, track); props.onChange({ ...document, tracks }, '调整灯光轨道顺序'); }}>{direction < 0 ? '上移轨道' : '下移轨道'}</button>)}
      <button onClick={() => props.onChange({ ...document, templates: [...document.templates, { id: crypto.randomUUID(), name: track.name, track: structuredClone(track) }] }, '保存灯光模板')}>保存轨道模板</button>
      <button disabled={track.locked} onClick={() => props.onChange({ ...document, tracks: document.tracks.filter((entry) => entry.id !== track.id) }, '删除灯光轨道')}>删除轨道</button>
    </div></> : section === 'arrangement' ? <div className="lighting-settings"><LightingArrangementSettings document={document} onChange={props.onChange} /></div> : section === 'files' ? <><p className="lighting-muted">支持 MIDI、REAPER（.rpp）和灯光工程文件，导入前可预览。</p><div className="lighting-tools"><LightingFileActions document={document} onChange={props.onChange} notify={props.notify} /></div></> : <>
      <div className="lighting-settings">
        <label>控制方式<select aria-label="控制方式" value={document.outputMode} onChange={(event) => props.onChange({ ...document, outputMode: event.target.value as LightingDocument['outputMode'] }, '修改灯光输出方式')}><option value="timecode">发送时间码，由 MA2 播放</option><option value="direct">由编排台逐条触发</option></select></label>
        {document.outputMode === 'direct' ? <label>事件输出端口<select aria-label="事件输出端口" value={track.portProfileId} disabled={track.locked} onChange={(event) => props.changeTrack({ ...track, portProfileId: event.target.value }, '配置灯光输出')}><option value="">未指定</option>{ports?.filter((port) => port.direction === 'output').map((port) => <option key={port.id} value={port.id}>{port.portName || '未连接端口'}</option>)}</select></label> : null}
      </div><div className="lighting-settings">

        <label>事件类型<select aria-label="灯光编辑内容" value={track.kind} disabled={track.locked || track.clips.some((clip) => clip.events.length > 0)} onChange={(event) => props.changeTrack({ ...track, kind: event.target.value as LightingTrack['kind'] }, '修改灯光编辑类型')}><option value="ma2">灯光切换（MA2 Cue）</option><option value="midi">音符与 MIDI 消息</option><option value="automation">推杆变化（MIDI CC）</option></select></label>
        <label>MIDI 通道<PropertyNumberInput label="MIDI 通道" min={1} max={16} value={track.channel} disabled={track.locked} onCommit={(channel) => props.changeTrack({ ...track, channel }, '修改 MIDI 通道')} /></label>
        {track.kind === 'automation' ? <label>推杆控制器（CC）<PropertyNumberInput label="推杆控制器（CC）" min={0} max={127} value={track.controller} disabled={track.locked} onCommit={(controller) => props.changeTrack({ ...track, controller }, '修改 CC 控制器')} /></label> : null}
      </div><p className="lighting-muted">{document.outputMode === 'timecode' ? '先在“节目同步”写入 MA2，播放时发送时间码。' : '播放时直接发送当前轨道的动作。'}端口在“设备连接”设置。</p>{track.clips.some((clip) => clip.events.length > 0) ? <p className="lighting-muted">已有编排的轨道保留原类型。需要编辑其他内容时，请添加一条空轨道。</p> : null}
    </>}
  </div></div>;
}


export function CueStampSettings({ document, track, changeTrack, notify }: { document: LightingDocument; track: LightingTrack; changeTrack: (track: LightingTrack, label: string) => void; notify: Props['notify'] }): JSX.Element {
  const stamp = track.cueStamp;
  const save = (cueStamp: NonNullable<LightingTrack['cueStamp']>): void => changeTrack({ ...track, cueStamp }, '修改灯光打点方式');
  return <>
    <label>打点方式<select aria-label="灯光打点方式" value={stamp?.mode ?? 'sequence'} disabled={track.locked} onChange={(input) => {
      if (input.currentTarget.value === 'sequence') save({ mode: 'sequence' });
      else if (input.currentTarget.value === 'marker') save({ mode: 'marker' });
      else {
        try { save(createFixedLightingCueStamp(document, track)); }
        catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
      }
    }}><option value="sequence">按 Cue 顺序</option><option value="fixed">重复同一个 Cue</option><option value="marker">只做标记</option></select></label>
    {stamp?.mode === 'fixed' ? <>
      <label>固定 Cue<input aria-label="固定 Cue 编号" key={`${track.id}:${stamp.cue}`} defaultValue={stamp.cue} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
        const cue = input.currentTarget.value.trim();
        if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(cue) || Number(cue) <= 0) { input.currentTarget.setCustomValidity('请输入有效 Cue 编号，例如 1.250'); input.currentTarget.reportValidity(); return; }
        if (cue !== stamp.cue) save({ ...stamp, cue });
      }} /></label>
      <label>序列<PropertyNumberInput label="固定 Cue 序列" value={stamp.sequence} min={1} max={99999} disabled={track.locked} onCommit={(sequence) => save({ ...stamp, sequence })} /></label>
      <label>执行器<input aria-label="固定 Cue 执行器" key={`${track.id}:${stamp.executor}`} defaultValue={stamp.executor} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
        const executor = input.currentTarget.value.trim();
        if (!/^[1-9]\d*\.[1-9]\d*$/.test(executor)) { input.currentTarget.setCustomValidity('请输入页.编号，例如 1.5'); input.currentTarget.reportValidity(); return; }
        if (executor !== stamp.executor) save({ ...stamp, executor });
      }} /></label>
    </> : null}
  </>;
}
