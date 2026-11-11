import { AudioLines, Scissors, Trash2 } from 'lucide-react';
import type { AudioBeatLevel } from '@tb/schema';
import type { AudioEditor } from './useAudioEditor';
import { PropertyNumberInput } from './PropertyNumberInput';
import { Button, Disclosure, WithUnit } from '../ui';
import type { EditorPlayhead } from './editor-playhead';

/**
 * The song audio's properties in the editor. The beats are the song's one record (core songBeats), recognised by the
 * 音乐识别 panel that the lighting workbench uses too (`onRecognise` opens it, 0.5.9 E11); here they are only shown at
 * a chosen spacing and used to split the audio.
 */
export function AudioInspector({ editor, playhead, onRecognise }: { editor: AudioEditor; playhead: EditorPlayhead; onRecognise: () => void }): JSX.Element {
  const segment = editor.selected;
  return <div className="inspector-body audio-inspector">
    <header><AudioLines /><strong>{editor.title}</strong><span>{editor.tracks.length} 条音轨 · {editor.segments.length} 个片段</span></header>
      <Disclosure className="audio-manual-edit" title="音频剪辑" open>
      <fieldset disabled={editor.disabled}><p>以下操作会切分或调整音频，都可以撤销。</p><Button variant="secondary" size="sm" icon={Scissors} disabled={!editor.points.length} onClick={() => void editor.splitAtBeats()}>按节拍切分音频</Button>
      {segment ? <div className="audio-segment-fields">
        <label><span>时间线位置</span><WithUnit unit="秒"><PropertyNumberInput className="ui-input" label="音频片段位置" min={0} step={0.001} value={segment.startMs / 1000} onCommit={(value) => { void editor.update(segment.id, { startMs: Math.round(value * 1000) }); }} /></WithUnit></label>
        <label><span>素材入点</span><WithUnit unit="秒"><PropertyNumberInput className="ui-input" label="音频素材入点" min={0} step={0.001} value={segment.sourceOffsetMs / 1000} onCommit={(value) => { void editor.update(segment.id, { sourceOffsetMs: Math.round(value * 1000) }); }} /></WithUnit></label>
        <label><span>片段时长</span><WithUnit unit="秒"><PropertyNumberInput className="ui-input" label="音频片段时长" min={0.001} step={0.001} value={segment.durationMs / 1000} onCommit={(value) => { void editor.update(segment.id, { durationMs: Math.round(value * 1000) }); }} /></WithUnit></label>
      </div> : <p>点击波形定位，拖动片段移动位置，拖动两端调整范围。</p>}
      <div className="audio-edit-actions"><Button variant="secondary" size="sm" icon={Scissors} onClick={() => void editor.split(playhead.read())}>播放头处分割</Button><Button variant="danger" size="sm" icon={Trash2} disabled={!segment} onClick={() => void editor.remove()}>删除片段</Button></div>
      </fieldset>
      {editor.disabled && !editor.busy ? <p>停止播放后才能移动、裁剪或删除音频片段。</p> : null}
      </Disclosure>
    <section className="audio-beat-properties"><h3>音乐的节拍</h3>
      <p>{editor.hasBeats ? `这首歌${editor.simpleBeats ? '用的是简易检测的节拍（准确度差一些），' : '的节拍'}和灯光工作台共用，按现在的间隔显示 ${editor.points.length} 个。` : editor.beatsStale ?? '这首歌还没有节拍。点“音乐识别”识别一次，灯光工作台也用这份。'}</p>
      <Button variant="secondary" className="audio-detect-button" icon={AudioLines} disabled={!editor.audio} onClick={onRecognise}>音乐识别</Button>
      <div className="audio-beat-levels" role="group" aria-label="节拍密度">{([['sparse', '每小节'], ['standard', '每两拍'], ['dense', '每拍']] as const).map(([value, label]) => <Button key={value} variant="secondary" size="sm" aria-pressed={editor.level === value} disabled={!editor.hasBeats} onClick={() => editor.setLevel(value satisfies AudioBeatLevel)}>{label}</Button>)}</div>
    </section>
    {editor.busy ? <p role="status">正在处理音频，请稍候…</p> : null}
  </div>;
}
