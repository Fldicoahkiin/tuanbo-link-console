import { AudioLines, Scissors, ScanLine, Trash2 } from 'lucide-react';
import type { AudioBeatLevel } from '@tb/schema';
import type { AudioEditor } from './useAudioEditor';
import { PropertyNumberInput } from './PropertyNumberInput';

export function AudioInspector({ editor, playheadMs }: { editor: AudioEditor; playheadMs: number }): JSX.Element {
  const segment = editor.selected;
  return <div className="inspector-body audio-inspector">
    <header><AudioLines /><strong>{editor.title}</strong><span>{editor.tracks.length} 条音轨 · {editor.segments.length} 个片段</span></header>
      <details className="audio-manual-edit" open><summary>音频剪辑</summary>
      <fieldset disabled={editor.disabled}><p>以下操作会切分或调整音频，均可撤销。</p><button disabled={!editor.points.length} onClick={() => void editor.splitAtBeats()}><Scissors />按节拍切分音频</button>
      {segment ? <div className="audio-segment-fields">
        <label><span>时间线位置 <small>秒</small></span><PropertyNumberInput label="音频片段位置" min={0} step={0.001} value={segment.startMs / 1000} onCommit={(value) => { void editor.update(segment.id, { startMs: Math.round(value * 1000) }); }} /></label>
        <label><span>素材入点 <small>秒</small></span><PropertyNumberInput label="音频素材入点" min={0} step={0.001} value={segment.sourceOffsetMs / 1000} onCommit={(value) => { void editor.update(segment.id, { sourceOffsetMs: Math.round(value * 1000) }); }} /></label>
        <label><span>片段时长 <small>秒</small></span><PropertyNumberInput label="音频片段时长" min={0.001} step={0.001} value={segment.durationMs / 1000} onCommit={(value) => { void editor.update(segment.id, { durationMs: Math.round(value * 1000) }); }} /></label>
      </div> : <p>点击波形定位，拖动片段移动位置，拖动两端调整范围。</p>}
      <div className="audio-edit-actions"><button onClick={() => void editor.split(playheadMs)}><Scissors />播放头处分割</button><button disabled={!segment} onClick={() => void editor.remove()}><Trash2 />删除片段</button></div>
      </fieldset>
      {editor.disabled && !editor.busy ? <p>停止播放后才能移动、裁剪或删除音频片段，节拍标记随时可以编辑。</p> : null}
      </details>
    <fieldset disabled={editor.busy}>
      <section className="audio-beat-properties"><h3>找到音乐的节拍</h3><p>先检测，再把节拍放到时间线上，方便对齐灯光。</p><button className="audio-detect-button" disabled={!editor.audio} onClick={() => void editor.analyze()}><ScanLine />{editor.busy ? '正在检测…' : '检测节拍'}</button>
        <div className="audio-beat-levels" role="group" aria-label="节拍密度">{([['sparse', '每四拍'], ['standard', '每两拍'], ['dense', '每拍']] as const).map(([value, label]) => <button key={value} aria-pressed={editor.level === value} onClick={() => editor.setLevel(value satisfies AudioBeatLevel)}>{label}</button>)}</div>
        <p>{editor.points.length ? `检测到 ${editor.points.length} 个节拍点，点“应用标记”后保存到工程。` : '检测完成后可以选择标记间隔。'}</p>
        <div className="audio-edit-actions"><button disabled={!editor.points.length} onClick={() => void editor.mark()}>应用标记</button><button disabled={!editor.points.length} onClick={() => void editor.clearMarks()}>清除标记</button></div>
      </section>
    </fieldset>
    {editor.busy ? <p role="status">正在处理音频，请稍候…</p> : null}
  </div>;
}
