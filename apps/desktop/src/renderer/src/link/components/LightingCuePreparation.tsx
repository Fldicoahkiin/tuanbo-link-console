import { useId } from 'react';
import type { LightingDocument } from '@tb/schema';
import type { CueIngredient } from './LightingCueComposer';
import { PropertyNumberInput } from './PropertyNumberInput';

export function LightingCuePreparation({ document, ingredients, onChange, cueTime, disabled }: {
  document: LightingDocument; ingredients: CueIngredient[]; onChange: (values: CueIngredient[]) => void; cueTime: number; disabled: boolean;
}): JSX.Element {
  const id = useId();
  const enabled = ingredients.filter(entry => entry.preparation);
  const leadMs = Math.max(0, ...enabled.map(entry => entry.preparation?.leadMs ?? 0));
  const update = (index: number, preparation: CueIngredient['preparation']): void => onChange(ingredients.map((entry, i) => {
    if (i !== index) return entry;
    const rest = { ...entry }; delete rest.preparation;
    return preparation ? { ...rest, preparation } : rest;
  }));
  return <details className="cue-preparation">
    <summary><span>埋步</span><small>{enabled.length ? `提前 ${leadMs / 1000} 秒 · ${enabled.length} 个准备 Cue` : '未启用'}</small></summary>
    <div className="cue-preparation-body">
      <p>准备 Cue 需在控台保存为灭灯状态。测试埋步请从准备时间之前播放。</p>
      {ingredients.map((entry, index) => {
        const choices = new Map<string, string>();
        for (const binding of document.ma2Bindings ?? []) for (const cue of binding.cueCatalog?.find(value => value.sequence === entry.sequence)?.cues ?? []) choices.set(String(Number(cue.number)), cue.name ?? '');
        for (const template of document.templates) {
          const stamp = template.track.cueStamp;
          if (stamp?.mode === 'fixed' && stamp.sequence === entry.sequence) choices.set(String(Number(stamp.cue)), template.name);
        }
        choices.delete(String(Number(entry.cue)));
        return <div className="cue-preparation-row" key={index}>
          <label className="cue-preparation-toggle"><input type="checkbox" aria-label={`素材 ${index + 1} 启用埋步`} checked={Boolean(entry.preparation)} disabled={disabled} onChange={event => update(index, event.target.checked ? { cue: '', leadMs: 1500 } : undefined)} /><span>{entry.name}<small>序列 {entry.sequence} · 正式 Cue {entry.cue}</small></span></label>
          {entry.preparation ? <>
            <label>准备 Cue<input aria-label={`素材 ${index + 1} 准备 Cue`} placeholder="选择或输入编号" list={`${id}-${index}`} value={entry.preparation.cue} disabled={disabled} onChange={event => update(index, { cue: event.target.value, leadMs: entry.preparation!.leadMs })} /><datalist id={`${id}-${index}`}>{[...choices].map(([cue, name]) => <option value={cue} key={cue}>{name || `Cue ${cue}`}</option>)}</datalist></label>
            <label>提前（秒）<PropertyNumberInput label={`素材 ${index + 1} 埋步提前秒数`} value={entry.preparation.leadMs / 1000} min={0.1} max={10} step={0.1} disabled={disabled} onCommit={value => update(index, { cue: entry.preparation!.cue, leadMs: Math.round(value * 1000) })} /></label>
          </> : null}
        </div>;
      })}
      {enabled.length ? <output className={cueTime < leadMs ? 'cue-preparation-invalid' : ''}>{cueTime < leadMs ? '准备时间早于节目开始，请缩短提前时间。' : `${((cueTime - leadMs) / 1000).toFixed(3)} 秒开始准备 → ${(cueTime / 1000).toFixed(3)} 秒正式亮灯`}</output> : null}
    </div>
  </details>;
}
