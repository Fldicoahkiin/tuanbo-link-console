import { Plus, Repeat2, Trash2 } from 'lucide-react';
import { Button, IconButton, Switch, TextInput } from '../ui';
import { LightingTempoSettings } from './LightingTempoSettings';
import { ownKeys } from '../keys/key-owner';
import type { LightingDocument } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';

export function LightingArrangementSettings({ document, onChange }: { document: LightingDocument; onChange: LightingTimelineProps['onChange'] }): JSX.Element {
  return <>
    <LightingTempoSettings document={document} onChange={onChange} />
    <fieldset className="loop-properties"><legend><Repeat2 aria-hidden="true" />循环范围</legend><Switch className="lighting-loop-toggle" label="循环" aria-label="启用循环" checked={document.loop.enabled} onChange={(e) => onChange({ ...document, loop: { ...document.loop, enabled: e.target.checked } }, '切换循环')} />
      <div className="loop-range-fields">{(['startMs', 'endMs'] as const).map((key) => <label key={key}><span className="loop-range-label">{key === 'startMs' ? '起点（秒）' : '终点（秒）'}</span><CommitNumber label={key === 'startMs' ? '灯光循环起点' : '灯光循环终点'} min={0} step={0.001} value={document.loop[key] / 1000} validate={(value) => (key === 'startMs' ? value * 1000 >= document.loop.endMs : value * 1000 <= document.loop.startMs) ? '循环终点必须晚于起点' : null} onCommit={(value) => onChange({ ...document, loop: { ...document.loop, [key]: Math.round(value * 1000) } }, '修改循环范围')} /><small className="loop-range-unit">s</small></label>)}</div>
    </fieldset>
    {document.markers.length ? <fieldset className="lighting-arrangement-list"><legend>标记与区域</legend>{document.markers.map((marker) => <div className="lighting-marker-settings" key={marker.id}>
      <label><span>名称</span><TextInput aria-label="标记名称" key={marker.name} defaultValue={marker.name} onBlur={(input) => {
        const name = input.currentTarget.value.trim();
        if (name !== marker.name) onChange({ ...document, markers: document.markers.map((entry) => entry.id === marker.id ? { ...entry, name } : entry) }, '修改标记名称');
      }} /></label>
      <label><span>起点（秒）</span><CommitNumber label="标记起点" min={0} step={0.001} value={marker.startMs / 1000} onCommit={(seconds) => {
        const startMs = Math.round(seconds * 1000);
        onChange({ ...document, markers: document.markers.map((entry) => entry.id === marker.id ? { ...entry, startMs, endMs: entry.endMs === null ? null : entry.endMs + startMs - entry.startMs } : entry) }, '移动标记');
      }} /></label>
      <label><span>终点（秒）</span><RegionEnd value={marker.endMs} startMs={marker.startMs} onCommit={(endMs) => onChange({ ...document, markers: document.markers.map((entry) => entry.id === marker.id ? { ...entry, endMs } : entry) }, '修改标记区域')} /></label>
      <IconButton label="删除标记" icon={Trash2} onClick={() => onChange({ ...document, markers: document.markers.filter((entry) => entry.id !== marker.id) }, '删除标记')} />
    </div>)}</fieldset> : null}
    {document.templates.length ? <fieldset className="lighting-arrangement-list"><legend>轨道模板</legend>{document.templates.map((template) => <div className="lighting-template-row" key={template.id}><span>{template.name}</span><Button variant="secondary" size="sm" icon={Plus} onClick={() => {
      const track = structuredClone(template.track); track.id = crypto.randomUUID(); track.locked = false;
      track.clips = track.clips.map((clip) => ({ ...clip, id: crypto.randomUUID(), events: clip.events.map((event) => ({ ...event, id: crypto.randomUUID() })) }));
      onChange({ ...document, tracks: [...document.tracks, track] }, '应用灯光模板');
    }}>添加到节目</Button><IconButton label={`删除模板 ${template.name}`} icon={Trash2} onClick={() => onChange({ ...document, templates: document.templates.filter((t) => t.id !== template.id) }, '删除灯光模板')} /></div>)}</fieldset> : null}
  </>;
}

function CommitNumber(props: { label: string; value: number; min: number; max?: number; step?: number; disabled?: boolean; validate?: (value: number) => string | null; onCommit: (value: number) => void }): JSX.Element {
  return <TextInput aria-label={props.label} key={props.value} type="number" min={props.min} max={props.max} step={props.step ?? 'any'} disabled={props.disabled} defaultValue={props.value} {...ownKeys('Escape')} onInput={(input) => input.currentTarget.setCustomValidity('')} onKeyDown={(input) => {
    if (input.key === 'Enter' || input.key === 'Escape') { input.preventDefault(); input.stopPropagation(); if (input.key === 'Escape') { input.currentTarget.value = String(props.value); input.currentTarget.setCustomValidity(''); } input.currentTarget.blur(); }
  }} onBlur={(input) => {
    const element = input.currentTarget; const value = element.valueAsNumber;
    const error = !Number.isFinite(value) ? '请输入有效数字' : props.validate?.(value);
    if (error) element.setCustomValidity(error);
    if (!element.reportValidity()) return;
    if (value !== props.value) props.onCommit(value);
  }} />;
}



function RegionEnd(props: { value: number | null; startMs: number; onCommit: (endMs: number | null) => void }): JSX.Element {
  const display = props.value === null ? '' : String(props.value / 1000);
  return <TextInput aria-label="标记区域终点" key={props.value} type="number" min={0} step={0.001} defaultValue={display} placeholder="留空为单点" {...ownKeys('Escape')} onInput={(input) => input.currentTarget.setCustomValidity('')} onKeyDown={(input) => {
    if (input.key === 'Enter' || input.key === 'Escape') { input.preventDefault(); input.stopPropagation(); if (input.key === 'Escape') { input.currentTarget.value = display; input.currentTarget.setCustomValidity(''); } input.currentTarget.blur(); }
  }} onBlur={(input) => {
    const field = input.currentTarget;
    const value = field.value === '' && !field.validity.badInput ? null : Math.round(field.valueAsNumber * 1000);
    if (value !== null && (!Number.isFinite(value) || value <= props.startMs)) field.setCustomValidity('区域终点必须晚于起点');
    if (field.reportValidity() && value !== props.value) props.onCommit(value);
  }} />;
}
