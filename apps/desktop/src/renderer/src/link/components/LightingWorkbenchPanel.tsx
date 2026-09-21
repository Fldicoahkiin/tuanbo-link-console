import { useState } from 'react';
import { Flag, Lightbulb, Scissors, Trash2 } from 'lucide-react';
import type { LightingDocument, RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useSelectedProgram } from '../useSelectedProgram';
import type { AudioEditor } from './useAudioEditor';
import type { LightingTool } from './LightingTimelineTools';
import { AudioInspector } from './AudioInspector';
import { PropertyNumberInput } from './PropertyNumberInput';

type Props = {
  item: RundownItem | null;
  editor: AudioEditor;
  document: LightingDocument;
  playheadMs: number;
  disabled: boolean;
  onChange: (document: LightingDocument, label: string) => void;
  onSeek: (timeMs: number) => void;
  onOpenTools: (tool: LightingTool) => void;
};

export function LightingProgramList({ currentItemId, disabled, notify }: {
  currentItemId: string | null; disabled: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const [, select] = useSelectedProgram(notify);
  return <section className="lighting-programs" aria-label="灯光节目列表">
    <header><Lightbulb /><strong>节目列表</strong></header>
    <p>选择要编灯的舞蹈</p>
    {project?.rundown.map((item, index) => <button key={item.id} title={item.title} disabled={disabled} aria-pressed={currentItemId === item.id} onClick={() => select(item.id)}>
      <span>{String(index + 1).padStart(2, '0')}</span><div><strong>{item.title}</strong><small>{item.referenceAudio ? `${(item.referenceAudio.durationMs / 1000).toFixed(1)} 秒 · ${item.lighting?.tracks.length ?? 0} 条灯光轨道` : '尚未添加音频'}</small></div>
    </button>)}
  </section>;
}

export function LightingWorkbenchPanel({ item, editor, document, playheadMs, disabled, onChange, onSeek }: Props): JSX.Element {
  const [tab, setTab] = useState<'beats' | 'regions'>('beats');
  const [name, setName] = useState('舞蹈段落');
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(item?.referenceAudio?.durationMs ?? 0);
  const durationMs = item?.referenceAudio?.durationMs ?? 0;
  const singleSegment = editor.segments.length === 1 ? editor.segments[0] : null;
  const validRange = startMs >= 0 && endMs > startMs && endMs <= durationMs;
  const markers = [...document.markers].sort((a, b) => a.startMs - b.startMs);
  const addRegion = (): void => {
    if (!validRange || !name.trim()) return;
    onChange({ ...document, markers: [...document.markers, { id: crypto.randomUUID(), name: name.trim(), startMs, endMs }] }, '添加编灯段落');
  };
  return <section className="lighting-workbench-panel" aria-label="音频分段工作区">
    <div className="lighting-task-tabs" role="tablist" aria-label="编灯步骤">
      <button role="tab" id="lighting-beats-tab" aria-controls="lighting-beats-panel" aria-selected={tab === 'beats'} onClick={() => setTab('beats')}>1 · 找节拍</button>
      <button role="tab" id="lighting-regions-tab" aria-controls="lighting-regions-panel" aria-selected={tab === 'regions'} onClick={() => setTab('regions')}>2 · 划段落</button>
    </div>
    {!item ? <p>从左侧选择一个节目开始。</p> : <>
      {singleSegment && singleSegment.startMs > 0 ? <div className="lighting-gap-notice"><span>音频前有 {(singleSegment.startMs / 1000).toFixed(3)} 秒空隙</span><button disabled={disabled || editor.disabled} onClick={() => void editor.update(singleSegment.id, { startMs: 0 })}>音频贴齐开头</button></div> : null}
      <div role="tabpanel" id="lighting-beats-panel" aria-labelledby="lighting-beats-tab" hidden={tab !== 'beats'}><AudioInspector editor={editor} playheadMs={playheadMs} /></div>
      <div role="tabpanel" id="lighting-regions-panel" aria-labelledby="lighting-regions-tab" hidden={tab !== 'regions'}>
      <div className="lighting-step-intro"><h3>把舞蹈划成几个段落</h3><p>试听左侧波形，用播放头确定起止位置。每个段落可以安排不同灯光。</p></div>
      <fieldset disabled={disabled || editor.busy || !durationMs} className="lighting-region-form">
        <legend>新建段落</legend>
        <label>名称<input aria-label="编灯段落名称" value={name} onChange={event => setName(event.currentTarget.value)} /></label>
        <label>起点 · 秒<PropertyNumberInput label="编灯段落起点" min={0} max={durationMs / 1000} step={0.001} value={startMs / 1000} onCommit={value => setStartMs(Math.round(value * 1000))} /></label>
        <button aria-label="播放头设为起点" onClick={() => setStartMs(Math.min(durationMs, Math.round(playheadMs)))}>用当前位置</button>
        <label>终点 · 秒<PropertyNumberInput label="编灯段落终点" min={0} max={durationMs / 1000} step={0.001} value={endMs / 1000} onCommit={value => setEndMs(Math.round(value * 1000))} /></label>
        <button aria-label="播放头设为终点" onClick={() => setEndMs(Math.min(durationMs, Math.round(playheadMs)))}>用当前位置</button>
        <button disabled={!validRange || !name.trim()} onClick={addRegion}><Flag />添加段落</button>
      </fieldset>
      <p className="lighting-workbench-hint">段落只标记范围，音乐会连续播放。</p>
      <div className="lighting-region-list" aria-label="编灯段落列表">
        {markers.length ? markers.map(marker => <div key={marker.id}>
          <button onClick={() => onSeek(marker.startMs)}><strong>{marker.name}</strong><small>{(marker.startMs / 1000).toFixed(3)}{marker.endMs !== null ? ` — ${(marker.endMs / 1000).toFixed(3)}` : ''} 秒</small></button>
          <button disabled={disabled} aria-label={`删除段落 ${marker.name}`} onClick={() => onChange({ ...document, markers: document.markers.filter(entry => entry.id !== marker.id) }, '删除编灯段落')}><Trash2 /></button>
        </div>) : <p>还没有段落。可以先标出开场、主舞、收尾。</p>}
      </div>
      <details className="lighting-extra-edit"><summary>需要切开音频？</summary><p>切片会修改音频编排，可以撤销。</p><button disabled={editor.disabled || !editor.audio} onClick={() => void editor.split(playheadMs)}><Scissors />切开音频</button></details>
      </div>
    </>}
  </section>;
}
