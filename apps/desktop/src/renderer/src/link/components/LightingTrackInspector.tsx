import { ArrowLeftRight, Save, Unlock } from 'lucide-react';
import { createFixedLightingCueStamp } from '@tb/core/link';
import type { LightingDocument, LightingTrack } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { PropertyNumberInput } from './PropertyNumberInput';
import { Button, Disclosure, Field, Select, TextInput } from '../ui';

export function LightingTrackInspector(props: LightingTimelineProps & { track: LightingTrack }): JSX.Element {
  const { track, document } = props;
  const change = (next: LightingTrack): void => props.onChange({ ...document, tracks: document.tracks.map((entry) => entry.id === track.id ? next : entry) }, '修改灯光轨道属性');
  const bindings = document.ma2Bindings?.flatMap((binding) => [...(binding.trackMappings ?? []), ...(binding.pendingTracks ?? [])].filter((entry) => entry.trackId === track.id).map((entry) => `Timecode ${binding.timecode} · ${entry.executor}`)) ?? [];
  return <div className="lighting-inspector lighting-track-inspector">
    <header className="lighting-inspector-header">
      <div><span className="lighting-inspector-eyebrow">灯光轨道{track.locked ? ' · 已锁定' : ''}</span><TextInput className="lighting-inspector-name" aria-label="灯光轨道名称" key={`${track.id}:${track.name}`} defaultValue={track.name} disabled={track.locked} onBlur={(input) => { const name = input.currentTarget.value.trim(); if (name && name !== track.name) change({ ...track, name }); else input.currentTarget.value = track.name; }} /></div>
      <span className="lighting-inspector-count">{track.clips.reduce((count, clip) => count + clip.events.length, 0)} 个点</span>
    </header>
    {track.locked ? <Button variant="secondary" size="sm" icon={Unlock} onClick={() => change({ ...track, locked: false })}>解锁轨道</Button> : null}
    <div className="lighting-inspector-grid">
      {track.kind === 'ma2' ? <CueStampSettings document={document} track={track} changeTrack={change} notify={(message) => props.onError?.(message)} /> : null}
      <Field stacked label="播放方式">{(field) => <Select {...field} aria-label="灯光播放方式" value={props.preview ? 'linked' : 'music'} onChange={(input) => props.onPreviewChange?.(input.target.value === 'linked')}><option value="music">仅播放音乐</option><option value="linked">播放音乐并控制灯光</option></Select>}</Field>
      {track.kind === 'ma2' ? <div className="lighting-inspector-value"><span>执行器</span><strong>{bindings.join('；') || '未绑定'}</strong></div> : null}
    </div>
    <footer className="lighting-inspector-actions"><Button variant="secondary" size="sm" icon={ArrowLeftRight} onClick={() => props.onOpenTools?.('sync')}>节目同步 / 绑定执行器</Button></footer>
    <Disclosure className="lighting-track-more" title="更多轨道设置">
      <div className="lighting-inspector-grid">
        <Field stacked label="分组">{(field) => <TextInput {...field} aria-label="灯光轨道分组" key={`${track.id}:${track.group}`} defaultValue={track.group} disabled={track.locked} onBlur={(input) => { if (input.currentTarget.value !== track.group) change({ ...track, group: input.currentTarget.value }); }} />}</Field>
        <Field stacked label="颜色">{(field) => <input {...field} className="lighting-track-color" aria-label="灯光轨道颜色" type="color" value={track.color} disabled={track.locked} onChange={(input) => change({ ...track, color: input.currentTarget.value })} />}</Field>
        <Field stacked label="事件类型">{(field) => <Select {...field} aria-label="灯光编辑内容" value={track.kind} disabled={track.locked || track.clips.some((clip) => clip.events.length > 0)} onChange={(input) => change({ ...track, kind: input.currentTarget.value as LightingTrack['kind'] })}><option value="ma2">MA2 Cue</option><option value="midi">MIDI 音符</option><option value="automation">控制曲线</option></Select>}</Field>
        <Field stacked label="MIDI 通道">{(field) => <PropertyNumberInput {...field} className="ui-input" label="MIDI 通道" min={1} max={16} value={track.channel} disabled={track.locked} onCommit={(channel) => change({ ...track, channel })} />}</Field>
        {track.kind === 'automation' ? <Field stacked label="控制器 CC">{(field) => <PropertyNumberInput {...field} className="ui-input" label="推杆控制器（CC）" min={0} max={127} value={track.controller} disabled={track.locked} onCommit={(controller) => change({ ...track, controller })} />}</Field> : null}
      </div>
      <Button variant="secondary" size="sm" icon={Save} onClick={() => props.onChange({ ...document, templates: [...document.templates, { id: crypto.randomUUID(), name: track.name, track: structuredClone(track) }] }, '保存灯光模板')}>保存轨道模板</Button>
    </Disclosure>
  </div>;
}

/** How the record button stamps Cues on an MA2 track: the next Cue, the same Cue again, or a marker only. */
export function CueStampSettings({ document, track, changeTrack, notify }: { document: LightingDocument; track: LightingTrack; changeTrack: (track: LightingTrack, label: string) => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const stamp = track.cueStamp;
  const save = (cueStamp: NonNullable<LightingTrack['cueStamp']>): void => changeTrack({ ...track, cueStamp }, '修改灯光打点方式');
  return <>
    <Field stacked label="打点方式">{(field) => <Select {...field} aria-label="灯光打点方式" value={stamp?.mode ?? 'sequence'} disabled={track.locked} onChange={(input) => {
      if (input.currentTarget.value === 'sequence') save({ mode: 'sequence' });
      else if (input.currentTarget.value === 'marker') save({ mode: 'marker' });
      else {
        try { save(createFixedLightingCueStamp(document, track)); }
        catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
      }
    }}><option value="sequence">按 Cue 顺序</option><option value="fixed">重复同一个 Cue</option><option value="marker">只做标记</option></Select>}</Field>
    {stamp?.mode === 'fixed' ? <>
      <Field stacked label="固定 Cue">{(field) => <TextInput {...field} aria-label="固定 Cue 编号" key={`${track.id}:${stamp.cue}`} defaultValue={stamp.cue} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
        const cue = input.currentTarget.value.trim();
        if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(cue) || Number(cue) <= 0) { input.currentTarget.setCustomValidity('请输入有效 Cue 编号，例如 1.250'); input.currentTarget.reportValidity(); return; }
        if (cue !== stamp.cue) save({ ...stamp, cue });
      }} />}</Field>
      <Field stacked label="序列">{(field) => <PropertyNumberInput {...field} className="ui-input" label="固定 Cue 序列" value={stamp.sequence} min={1} max={99999} disabled={track.locked} onCommit={(sequence) => save({ ...stamp, sequence })} />}</Field>
      <Field stacked label="执行器">{(field) => <TextInput {...field} aria-label="固定 Cue 执行器" key={`${track.id}:${stamp.executor}`} defaultValue={stamp.executor} disabled={track.locked} onInput={(input) => input.currentTarget.setCustomValidity('')} onBlur={(input) => {
        const executor = input.currentTarget.value.trim();
        if (!/^[1-9]\d*\.[1-9]\d*$/.test(executor)) { input.currentTarget.setCustomValidity('请输入页.编号，例如 1.5'); input.currentTarget.reportValidity(); return; }
        if (executor !== stamp.executor) save({ ...stamp, executor });
      }} />}</Field>
    </> : null}
  </>;
}
