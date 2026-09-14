import { Gauge, Plus, Trash2 } from 'lucide-react';
import type { LightingDocument, LightingTempo } from '@tb/schema';
import { PropertyNumberInput } from './PropertyNumberInput';

type Props = { document: LightingDocument; onChange: (document: LightingDocument, label: string) => void };

export function LightingTempoSettings({ document, onChange }: Props): JSX.Element {
  const first = document.tempos[0];
  const change = (index: number, patch: Partial<LightingTempo>): void => {
    if (patch.beat !== undefined && document.tempos.some((tempo, i) => i !== index && tempo.beat === patch.beat)) throw new Error('这个位置已有变速点');
    onChange({ ...document, tempos: document.tempos.map((tempo, i) => i === index ? { ...tempo, ...patch } : tempo).sort((a, b) => a.beat - b.beat) }, '编辑节拍图');
  };
  return <fieldset className="tempo-properties"><legend><Gauge aria-hidden="true" />节拍与速度</legend>
    {first ? <div className="tempo-primary-fields">
      <label><span>速度</span><div className="property-number-unit"><PropertyNumberInput label="变速点 1 BPM" min={10} max={999} step={0.01} value={first.bpm} onCommit={(bpm) => change(0, { bpm })} /><small>BPM</small></div></label>
      <div className="tempo-signature-field"><span>拍号</span><TempoSignature tempo={first} index={0} onChange={(patch) => change(0, patch)} /></div>
    </div> : null}
    <details className="tempo-points"><summary>变速点<span>{document.tempos.length > 1 ? `${document.tempos.length} 个` : '固定速度'}</span></summary>
      {document.tempos.map((tempo, index) => <div className="tempo-point" key={index}>
        <div className="tempo-point-heading"><strong>{index === 0 ? '初始速度' : `变速点 ${index + 1}`}</strong>{index > 0 ? <button aria-label={`删除变速点 ${index + 1}`} title="删除变速点" onClick={() => onChange({ ...document, tempos: document.tempos.filter((_, i) => i !== index) }, '删除变速点')}><Trash2 /></button> : null}</div>
        <div className="tempo-point-fields">
          <label><span>节拍位置</span><PropertyNumberInput label={`变速点 ${index + 1} 节拍`} min={0} step={0.001} disabled={index === 0} value={tempo.beat} onCommit={(beat) => change(index, { beat })} /></label>
          {index > 0 ? <><label><span>速度 <small>BPM</small></span><PropertyNumberInput label={`变速点 ${index + 1} BPM`} min={10} max={999} step={0.01} value={tempo.bpm} onCommit={(bpm) => change(index, { bpm })} /></label><div className="tempo-signature-field"><span>拍号</span><TempoSignature tempo={tempo} index={index} onChange={(patch) => change(index, patch)} /></div></> : null}
          {index < document.tempos.length - 1 ? <label className="tempo-transition"><span>速度变化</span><select aria-label={`变速点 ${index + 1} 变化方式`} value={tempo.transition ?? 'hold'} onChange={(event) => { const transition = event.currentTarget.value; if (transition === 'hold' || transition === 'linear') change(index, { transition }); }}><option value="hold">保持速度</option><option value="linear">渐变至下一点</option></select></label> : null}
        </div>
      </div>)}
      <button className="property-add-button" onClick={() => { const last = document.tempos.at(-1); if (last) onChange({ ...document, tempos: [...document.tempos, { ...last, beat: last.beat + 4 }] }, '添加变速点'); }}><Plus />添加变速点</button>
    </details>
  </fieldset>;
}

function TempoSignature({ tempo, index, onChange }: { tempo: LightingTempo; index: number; onChange: (patch: Partial<LightingTempo>) => void }): JSX.Element {
  return <div className="lighting-tempo-signature">
    <PropertyNumberInput label={`变速点 ${index + 1} 拍号`} min={1} max={32} value={tempo.numerator} onCommit={(numerator) => onChange({ numerator })} />
    <span aria-hidden="true">/</span>
    <select aria-label={`变速点 ${index + 1} 拍号分母`} value={tempo.denominator} onChange={(event) => { const denominator = Number(event.currentTarget.value); if (denominator === 1 || denominator === 2 || denominator === 4 || denominator === 8 || denominator === 16) onChange({ denominator }); }}>{[1, 2, 4, 8, 16].map((value) => <option key={value}>{value}</option>)}</select>
  </div>;
}
