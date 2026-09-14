import { AudioLines, Scissors, ScanLine, Trash2 } from 'lucide-react';
import type { AudioBeatLevel } from '@tb/schema';
import type { AudioEditor } from './useAudioEditor';
import { PropertyNumberInput } from './PropertyNumberInput';

export function AudioInspector({ editor, playheadMs }: { editor: AudioEditor; playheadMs: number }): JSX.Element {
  const segment = editor.selected;
  return <div className="inspector-body audio-inspector">
    <header><AudioLines /><strong>歌曲音频</strong><span>{editor.segments.length} 个片段</span></header>
    <fieldset disabled={editor.busy}>
      <section className="audio-beat-properties"><h3>自动节拍</h3>
        <div className="audio-beat-levels" role="group" aria-label="节拍密度">{([['sparse', '稀疏'], ['standard', '标准'], ['dense', '密集']] as const).map(([value, label]) => <button key={value} aria-pressed={editor.level === value} onClick={() => editor.setLevel(value satisfies AudioBeatLevel)}>{label}</button>)}</div>
        <p>稀疏：约每四拍 · 标准：约每两拍 · 密集：每个主拍。标记用于灯光 Cue 吸附，不切分音频。</p>
        <div className="audio-edit-actions"><button onClick={() => void editor.analyze()}><ScanLine />检测节拍</button><span>{editor.points.length} 个节拍点</span></div>
        <div className="audio-edit-actions"><button disabled={!editor.points.length} onClick={() => void editor.mark()}>应用标记</button><button disabled={!editor.points.length} onClick={() => void editor.clearMarks()}>清除标记</button></div>
      </section>
    </fieldset>
      <details className="audio-manual-edit"><summary>音频剪辑</summary>
      <fieldset disabled={editor.disabled}>
      {segment ? <div className="audio-segment-fields">
        <label><span>时间线位置 <small>秒</small></span><PropertyNumberInput label="音频片段位置" min={0} step={0.001} value={segment.startMs / 1000} onCommit={(value) => { void editor.update(segment.id, { startMs: Math.round(value * 1000) }); }} /></label>
        <label><span>素材入点 <small>秒</small></span><PropertyNumberInput label="音频素材入点" min={0} step={0.001} value={segment.sourceOffsetMs / 1000} onCommit={(value) => { void editor.update(segment.id, { sourceOffsetMs: Math.round(value * 1000) }); }} /></label>
        <label><span>片段时长 <small>秒</small></span><PropertyNumberInput label="音频片段时长" min={0.001} step={0.001} value={segment.durationMs / 1000} onCommit={(value) => { void editor.update(segment.id, { durationMs: Math.round(value * 1000) }); }} /></label>
      </div> : <p>在音频轨道上选择片段，拖动位置或两端调整范围。</p>}
      <div className="audio-edit-actions"><button onClick={() => void editor.split(playheadMs)}><Scissors />播放头处分割</button><button disabled={!segment || editor.segments.length < 2} onClick={() => void editor.remove()}><Trash2 />删除片段</button></div>
      </fieldset>
      {editor.disabled && !editor.busy ? <p>停止播放后可移动、裁剪或删除音频片段；节拍标记仍可操作。</p> : null}
      </details>
    {editor.busy ? <p role="status">正在处理音频，请稍候…</p> : null}
  </div>;
}
