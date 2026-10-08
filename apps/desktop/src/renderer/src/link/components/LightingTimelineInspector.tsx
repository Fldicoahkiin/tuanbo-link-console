import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { LightingTempoMap, lightingEventTime, offsetLightingEvents } from '@tb/core/link';
import { lightingEventSchema, type LightingEvent, type LightingClip, type LightingTrack } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { LightingTrackInspector } from './LightingTrackInspector';
import { LightingEventFields } from './LightingEventFields';

function songPosition(ms: number): string {
  return `${Math.floor(ms / 60000).toString().padStart(2, '0')}:${(ms / 1000 % 60).toFixed(3).padStart(6, '0')}`;
}

export function LightingTimelineInspector(props: LightingTimelineProps & { trackId: string }): JSX.Element {
  const track = props.document.tracks.find((entry) => entry.id === props.trackId);
  const clip = track?.clips.find((entry) => entry.id === props.selectedClipId);
  const event = clip?.events.find((entry) => entry.id === props.selectedEventId);
  const map = useMemo(() => new LightingTempoMap(props.document.tempos), [props.document.tempos]);
  if (!track) return <div className="inspector-empty">选择灯光轨道查看属性</div>;
  const ids = new Set(props.selectedEventIds ?? []);
  const selected = clip?.events.filter((entry) => ids.has(entry.id)) ?? [];
  if (clip && selected.length > 1) return <LightingSelectionInspector {...props} track={track} clip={clip} selected={selected} map={map} />;
  if (!clip || !event) return <LightingTrackInspector {...props} track={track} />;
  const update = (changed: LightingEvent): void => {
    if (!clip || track.locked) return;
    const previous = clip.events.find((entry) => entry.id === changed.id);
    if (!previous || JSON.stringify(previous) === JSON.stringify(changed)) return;
    const events = clip.events.map((entry) => entry.id === changed.id ? changed : entry);
    const duration = events.reduce((end, entry) => Math.max(end, entry.at + (entry.kind === 'note' ? entry.duration : 0.001)), clip.duration);
    props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? { ...track, clips: track.clips.map((entry) => entry.id === clip.id ? { ...clip, duration, events } : entry) } : entry) }, '修改灯光点');
  };
  return <div className="lighting-editor lighting-inspector property-sheet flat-lighting">
    <div className="property-identity">
      <div><span className="property-eyebrow">{event ? '灯光点' : '灯光轨道'}{track.locked ? ' · 已锁定' : ''}</span>
        {event?.kind === 'ma2' || event?.kind === 'ma2-fader' ? <input className="property-name" aria-label={event.kind === 'ma2' ? 'Cue 名称' : '推杆点名称'} value={event.label} disabled={track.locked} onChange={(input) => update({ ...event, label: input.target.value })} /> : <strong>{track.name}</strong>}
      </div>
      {clip && event ? <output aria-label="灯光点时间显示">{songPosition(lightingEventTime(clip, event, map))}</output> : <span className="property-count">{track.clips.reduce((count, entry) => count + entry.events.length, 0)} 个点</span>}
    </div>
    {clip && event ? <section className="property-section">
      <div className="property-fields lighting-inspector-fields">
        <label><span title="音乐播放到这个时间时执行灯光动作">触发时间 <small>秒</small></span><input aria-label="灯光点歌曲时间" type="number" min={0} max={86399} step="0.001" key={`${event.id}:${lightingEventTime(clip, event, map)}`} defaultValue={Number((lightingEventTime(clip, event, map) / 1000).toFixed(6))} disabled={track.locked} onBlur={(input) => {
          if (input.currentTarget.value === String(Number((lightingEventTime(clip, event, map) / 1000).toFixed(6)))) return;
          const ms = input.target.valueAsNumber * 1000;
          const valid = Number.isFinite(ms) && ms >= 0 && ms <= 86399000;
          const at = valid ? (clip.timeLock === 'time' ? ms : map.msToBeat(ms)) - clip.start : -1;
          if (valid && at >= 0) update({ ...event, at });
          else { input.target.value = String(lightingEventTime(clip, event, map) / 1000); input.target.setCustomValidity('请输入片段起点之后的有效时间'); input.target.reportValidity(); }
        }} onInput={(input) => input.currentTarget.setCustomValidity('')} /></label>
        {event.kind === 'ma2' ? <>{event.action === 'goto' ? <label><span title="MA2 控台中要调用的 Cue 编号">控台 Cue</span><input aria-label="Cue 编号" key={`${event.id}:${event.cue}`} defaultValue={event.cue} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => { const cue = input.currentTarget.value.trim(); if (lightingEventSchema.safeParse({ ...event, cue }).success) { if (cue !== event.cue) update({ ...event, cue }); } else { input.currentTarget.value = event.cue ?? ''; input.currentTarget.setCustomValidity('请输入 Cue 编号，例如 1 或 1.25'); input.currentTarget.reportValidity(); } }} /></label> : null}

        </> : <LightingEventFields event={event} timeLock={clip.timeLock} disabled={track.locked} onChange={update} />}
      </div>
      {event.kind === 'ma2' ? <div className="property-target" key={event.id}><div className="property-fields lighting-inspector-fields">
        {event.action === 'goto' ? <label><span>序列</span><input aria-label="序列" type="number" min={1} max={99999} key={event.sequence} defaultValue={event.sequence} disabled={track.locked} onBlur={(input) => { const value = input.target.valueAsNumber; if (Number.isInteger(value) && value >= 1 && value <= 99999) update({ ...event, sequence: value }); else input.target.value = String(event.sequence); }} /></label> : null}
        <label><span>执行器</span><input aria-label="执行器" title="页.编号" key={event.executor} defaultValue={event.executor} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => { const executor = input.currentTarget.value.trim(); if (/^[1-9]\d*\.[1-9]\d*$/.test(executor)) { if (executor !== event.executor) update({ ...event, executor }); } else { input.currentTarget.value = event.executor; input.currentTarget.setCustomValidity('请输入页.编号，例如 1.5'); input.currentTarget.reportValidity(); } }} /></label>
      </div></div> : null}
    </section> : <div className="property-empty-hint">在下方时间线上选择一个灯光点进行编辑</div>}
    {event?.kind === 'ma2' ? <label className="property-row"><span>到点执行</span><select aria-label="MA2 动作" value={event.action} disabled={track.locked} onChange={(input) => update({ ...event, ...(input.target.value === 'goto' ? { cue: event.cue ?? '1', sequence: event.sequence ?? 1 } : {}), action: input.target.value as typeof event.action })}><option value="goto">调用此 Cue</option><option value="go" disabled={!event.executor || Boolean(event.preparation)}>播放控台下一步</option><option value="off" disabled={!event.executor || Boolean(event.preparation)}>关闭执行器</option></select></label> : null}
    <button onClick={() => props.onSelect(track.id, clip.id)}>轨道属性</button>
    <footer className="property-footer">{clip && event ? <button className="danger-text" disabled={track.locked} onClick={() => props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? { ...track, clips: track.clips.map((entry) => entry.id === clip.id ? { ...clip, events: clip.events.filter((entry) => entry.id !== event.id) } : entry) } : entry) }, '删除灯光点')}><Trash2 />删除灯光点</button> : null}</footer>
  </div>;
}

function LightingSelectionInspector(props: LightingTimelineProps & { track: LightingTrack; clip: LightingClip; selected: LightingEvent[]; map: LightingTempoMap }): JSX.Element {
  const { track, clip, selected, map } = props;
  const ids = new Set(selected.map((event) => event.id));
  const ma2 = selected.filter((event) => event.kind === 'ma2');
  const save = (next: LightingClip, label: string): void => {
    if (track.locked) return;
    props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? { ...entry, clips: entry.clips.map((part) => part.id === clip.id ? next : part) } : entry) }, label);
  };
  const update = (patch: Partial<Pick<Extract<LightingEvent, { kind: 'ma2' }>, 'executor' | 'sequence' | 'action'>>): void => save({ ...clip, events: clip.events.map((event) => ids.has(event.id) && event.kind === 'ma2' ? { ...event, ...(patch.action === 'goto' ? { cue: event.cue ?? '1', sequence: event.sequence ?? 1 } : {}), ...patch } : event) }, '批量修改灯光点');
  const common = <T,>(values: T[]): T | undefined => values.every((value) => value === values[0]) ? values[0] : undefined;
  const executor = common(ma2.map((event) => event.executor)) ?? '';
  const sequence = common(ma2.map((event) => event.sequence)) ?? '';
  const action = common(ma2.map((event) => event.action)) ?? '';
  return <div className="lighting-editor lighting-inspector property-sheet flat-lighting">
    <div className="property-identity"><strong>已选 {selected.length} 个灯光点</strong></div>
    <label className="property-row"><span title="正数整体后移，负数整体前移">偏移秒数</span><input aria-label="灯光批量时间偏移" type="number" step="0.001" defaultValue={0} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
      try { const offset = input.currentTarget.valueAsNumber * 1000; if (offset !== 0) save(offsetLightingEvents(clip, ids, offset, map), '批量偏移灯光点'); input.currentTarget.value = '0'; }
      catch (error) { input.currentTarget.setCustomValidity(error instanceof Error ? error.message : String(error)); input.currentTarget.reportValidity(); }
    }} /></label>
    {ma2.length === selected.length ? <>
      <label className="property-row"><span>执行器</span><input aria-label="批量执行器" title="页.编号" key={`executor:${executor}`} defaultValue={executor} placeholder="多个值" disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => { const value = input.currentTarget.value.trim(); if (!value) return; if (/^[1-9]\d*\.[1-9]\d*$/.test(value)) update({ executor: value }); else { input.currentTarget.setCustomValidity('请输入页.编号，例如 1.5'); input.currentTarget.reportValidity(); } }} /></label>
      {ma2.some((event) => event.action === 'goto') ? <label className="property-row"><span>序列</span><input aria-label="批量序列" type="number" min={1} max={99999} key={`sequence:${sequence}`} defaultValue={sequence} placeholder="多个值" disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => { if (!input.currentTarget.value) return; const value = input.currentTarget.valueAsNumber; if (Number.isInteger(value) && value > 0 && value <= 99999) update({ sequence: value }); else { input.currentTarget.setCustomValidity('序列应为 1 至 99999 的整数'); input.currentTarget.reportValidity(); } }} /></label> : null}
      <label className="property-row"><span>到点执行</span><select aria-label="批量 MA2 动作" value={action} disabled={track.locked} onChange={(input) => { const value = input.currentTarget.value; if (value === 'goto' || value === 'go' || value === 'off') update({ action: value }); }}><option value="" disabled>多个值</option><option value="goto">调用各自 Cue</option><option value="go" disabled={ma2.some(entry => !entry.executor || Boolean(entry.preparation))}>播放控台下一步</option><option value="off" disabled={ma2.some(entry => !entry.executor || Boolean(entry.preparation))}>关闭执行器</option></select></label>
    </> : null}
    <footer className="property-footer"><button className="danger-text" disabled={track.locked} onClick={() => { save({ ...clip, events: clip.events.filter((event) => !ids.has(event.id)) }, '批量删除灯光点'); props.onSelect(track.id, clip.id); }}><Trash2 />删除选中灯光点</button></footer>
  </div>;
}
