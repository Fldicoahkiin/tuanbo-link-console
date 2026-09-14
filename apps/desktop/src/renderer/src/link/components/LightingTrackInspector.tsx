import type { LightingTrack } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { CueStampSettings } from './LightingEditor';
import { PropertyNumberInput } from './PropertyNumberInput';
import { useIntegrationStore } from '../stores/integration-store';

export function LightingTrackInspector(props: LightingTimelineProps & { track: LightingTrack }): JSX.Element {
  const { track, document } = props;
  const profile = useIntegrationStore((state) => state.profile);
  const ports = profile?.midiPortProfiles ?? [];
  const change = (next: LightingTrack): void => props.onChange({ ...document, tracks: document.tracks.map((entry) => entry.id === track.id ? next : entry) }, '修改灯光轨道属性');
  const bindings = document.ma2Bindings?.flatMap((binding) => [...(binding.trackMappings ?? []), ...(binding.pendingTracks ?? [])].filter((entry) => entry.trackId === track.id).map((entry) => `Timecode ${binding.timecode} · ${entry.executor}`)) ?? [];
  return <div className="lighting-inspector property-sheet lighting-track-properties">
    <div className="property-identity"><div><span className="property-eyebrow">灯光轨道{track.locked ? ' · 已锁定' : ''}</span><input className="property-name" aria-label="灯光轨道名称" key={`${track.id}:${track.name}`} defaultValue={track.name} disabled={track.locked} onBlur={(input) => { const name = input.currentTarget.value.trim(); if (name && name !== track.name) change({ ...track, name }); else input.currentTarget.value = track.name; }} /></div><span className="property-count">{track.clips.reduce((count, clip) => count + clip.events.length, 0)} 个点</span></div>
    {track.locked ? <button onClick={() => change({ ...track, locked: false })}>解锁轨道</button> : null}
    <div className="lighting-track-fields">
      {track.kind === 'ma2' ? <CueStampSettings document={document} track={track} changeTrack={change} notify={(message) => props.onError?.(message)} /> : null}
      <label>播放方式<select aria-label="灯光播放方式" value={props.preview ? 'linked' : 'music'} onChange={(input) => props.onPreviewChange?.(input.target.value === 'linked')}><option value="music">仅播放音乐</option><option value="linked">播放音乐并控制灯光</option></select></label>
      <label>控制方式<select aria-label="控制方式" value={document.outputMode} onChange={(input) => props.onChange({ ...document, outputMode: input.currentTarget.value === 'direct' ? 'direct' : 'timecode' }, '修改灯光输出方式')}><option value="timecode">发送时间码，由 MA2 播放</option><option value="direct">编排台直接触发</option></select></label>
      {track.kind === 'ma2' ? <label>执行器<span className="lighting-binding-value">{bindings.join('；') || '未绑定'}</span></label> : null}
    </div>
    <div className="property-footer"><button onClick={() => props.onOpenTools?.('sync')}>节目同步 / 绑定执行器</button></div>
    <details className="lighting-track-more"><summary>更多轨道设置</summary><div className="lighting-track-fields">
      <label>分组<input aria-label="灯光轨道分组" key={`${track.id}:${track.group}`} defaultValue={track.group} disabled={track.locked} onBlur={(input) => { if (input.currentTarget.value !== track.group) change({ ...track, group: input.currentTarget.value }); }} /></label>
      <label>颜色<input aria-label="灯光轨道颜色" type="color" value={track.color} disabled={track.locked} onChange={(input) => change({ ...track, color: input.currentTarget.value })} /></label>
      <label>事件类型<select aria-label="灯光编辑内容" value={track.kind} disabled={track.locked || track.clips.some((clip) => clip.events.length > 0)} onChange={(input) => change({ ...track, kind: input.currentTarget.value as LightingTrack['kind'] })}><option value="ma2">MA2 Cue</option><option value="midi">MIDI 音符</option><option value="automation">控制曲线</option></select></label>
      {document.outputMode === 'direct' ? <label>事件输出端口<select aria-label="事件输出端口" value={track.portProfileId} disabled={track.locked} onChange={(input) => change({ ...track, portProfileId: input.currentTarget.value })}><option value="">使用默认灯光输出</option>{ports.filter((port) => port.direction === 'output').map((port) => <option key={port.id} value={port.id}>{port.portName || '未配置'}</option>)}</select></label> : null}
      <label>MIDI 通道<PropertyNumberInput label="MIDI 通道" min={1} max={16} value={track.channel} disabled={track.locked} onCommit={(channel) => change({ ...track, channel })} /></label>
      {track.kind === 'automation' ? <label>控制器 CC<PropertyNumberInput label="推杆控制器（CC）" min={0} max={127} value={track.controller} disabled={track.locked} onCommit={(controller) => change({ ...track, controller })} /></label> : null}
    </div><button onClick={() => props.onChange({ ...document, templates: [...document.templates, { id: crypto.randomUUID(), name: track.name, track: structuredClone(track) }] }, '保存灯光模板')}>保存轨道模板</button></details>
  </div>;
}
